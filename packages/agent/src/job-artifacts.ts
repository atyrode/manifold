import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { createGunzip, createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  writeSync,
  readSync,
  fstatSync,
} from "node:fs";
import { MachineArtifactSchema, type MachineArtifact } from "@manifold/protocol";
import type { HeldDirectory } from "./job-files.ts";
import { safeComponent } from "./job-files.ts";

export interface ArtifactAuthority {
  /** Explicit installed destination consent, exact HTTPS origins, checked on every hop. */
  origins: readonly string[];
  maxRedirects: number;
  timeoutMs: number;
}
export interface PinnedArtifactFile {
  readonly fd: number;
  readonly entrySha256: string;
  readonly bytes: number;
}
export interface ExtractedArtifact {
  executable: Buffer;
  files: Readonly<Record<string, Buffer>>;
}
export interface PinnedArtifact {
  /** Read-only executable fd; caller owns close(). Never reopen its published pathname. */
  fd: number;
  archiveSha256: string;
  entrySha256: string;
  bytes: number;
  readonly files: Readonly<Record<string, PinnedArtifactFile>>;
  close(): void;
}

/** Conservative globally routable unicast policy; mapped IPv4 and special IPv6 ranges refuse. */
export function isPublicArtifactAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const groups = address.toLowerCase().split(":");
  const first = parseInt(groups[0] ?? "", 16);
  const second = parseInt(groups[1] || "0", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    !(first === 0x3fff && second < 0x1000)
  );
}
function approvedUrl(value: string, authority: ArtifactAuthority): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !authority.origins.includes(url.origin)
  )
    throw new Error("artifact_destination_not_approved");
  return url;
}
async function download(
  artifact: MachineArtifact,
  authority: ArtifactAuthority,
  signal: AbortSignal,
): Promise<Buffer> {
  let url = approvedUrl(artifact.url, authority);
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await new Promise<LookupAddress[]>((resolve, reject) => {
          const abort = () => reject(new Error("artifact_deadline"));
          signal.addEventListener("abort", abort, { once: true });
          lookup(hostname, { all: true, verbatim: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((item) => !isPublicArtifactAddress(item.address)))
      throw new Error("artifact_private_destination");
    const pinned = addresses[0]!;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      // A fresh non-pooled socket and fixed lookup answer bind the checked DNS address to TLS.
      const req = request(
        url,
        {
          agent: false,
          family: pinned.family,
          rejectUnauthorized: true,
          maxHeaderSize: 16384,
          signal,
          headers: { "accept-encoding": "identity" },
          lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
        },
        resolve,
      );
      req.once("error", reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy();
      if (hop >= authority.maxRedirects || !response.headers.location)
        throw new Error("artifact_redirect_limit");
      url = approvedUrl(new URL(response.headers.location, url).href, authority);
      continue;
    }
    if (
      response.statusCode !== 200 ||
      (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
    ) {
      response.destroy();
      throw new Error("artifact_http_refused");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > artifact.maxBytes) {
        response.destroy();
        throw new Error("artifact_compressed_limit");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, bytes);
  }
}
async function expand(
  bytes: Buffer,
  format: "gzip" | "deflate",
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const decoder = format === "gzip" ? createGunzip() : createInflateRaw();
  const abort = () => decoder.destroy(new Error("artifact_deadline"));
  signal.addEventListener("abort", abort, { once: true });
  const source = Readable.from([bytes]);
  source.pipe(decoder);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of decoder) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new Error("artifact_expanded_limit");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy();
    decoder.destroy();
  }
}
function archiveName(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  if (nul >= 0 && bytes.subarray(nul).some((value) => value !== 0))
    throw new Error("artifact_invalid_name");
  const name = new TextDecoder("utf-8", { fatal: true }).decode(
    nul < 0 ? bytes : bytes.subarray(0, nul),
  );
  const parts = name.replace(/\/$/, "").split("/");
  for (const part of parts) safeComponent(part);
  return name;
}
function octal(bytes: Buffer): number {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("artifact_invalid_tar_number");
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("artifact_invalid_tar_number");
  return value;
}
/** Exported for deterministic archive regression fixtures; no filesystem extraction or path reopening. */
export async function extractArtifact(
  archive: Buffer,
  spec: MachineArtifact,
  signal: AbortSignal,
  deadline = Infinity,
): Promise<ExtractedArtifact> {
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("artifact_deadline");
  };
  checkDeadline();
  if (archive.length > spec.maxBytes) throw new Error("artifact_compressed_limit");
  if (createHash("sha256").update(archive).digest("hex") !== spec.sha256)
    throw new Error("artifact_archive_digest");
  const wanted = spec.entry.join("/");
  for (const part of spec.entry) safeComponent(part);
  const selected = new Map<string, string>([[wanted, spec.entrySha256]]);
  const extracted = new Map<string, Buffer>();
  for (const [name, file] of Object.entries(spec.files ?? {})) {
    safeComponent(name);
    for (const part of file.entry) safeComponent(part);
    const path = file.entry.join("/");
    if (selected.has(path) && selected.get(path) !== file.sha256)
      throw new Error("artifact_conflicting_entry_digest");
    selected.set(path, file.sha256);
  }
  if (spec.format === "raw") {
    if (Object.keys(spec.files ?? {}).length) throw new Error("artifact_raw_bundle");
    if (archive.length > spec.maxExpandedBytes) throw new Error("artifact_expanded_limit");
    extracted.set(wanted, archive);
  } else if (spec.format === "tar.gz") {
    const tar = await expand(archive, "gzip", spec.maxExpandedBytes, signal);
    let offset = 0;
    let members = 0;
    let ended = false;
    while (offset + 512 <= tar.length) {
      checkDeadline();
      const header = tar.subarray(offset, offset + 512);
      if (header.every((value) => value === 0)) {
        if (tar.length - offset < 1024 || tar.subarray(offset).some((value) => value !== 0))
          throw new Error("artifact_tar_termination");
        ended = true;
        break;
      }
      if (++members > spec.maxMembers) throw new Error("artifact_member_limit");
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (sum !== octal(header.subarray(148, 156))) throw new Error("artifact_tar_checksum");
      const prefix = header.subarray(345, 500);
      const name = archiveName(header.subarray(0, 100));
      const fullName = prefix.some((value) => value !== 0)
        ? `${archiveName(prefix)}/${name}`
        : name;
      const size = octal(header.subarray(124, 136));
      const kind = header[156];
      if (kind !== 0 && kind !== 48 && kind !== 53) throw new Error("artifact_unsafe_member");
      if (header.subarray(157, 257).some((value) => value !== 0) || (kind === 53 && size !== 0))
        throw new Error("artifact_unsafe_member");
      const end = offset + 512 + size;
      if (end > tar.length) throw new Error("artifact_truncated_tar");
      if (selected.has(fullName)) {
        if (extracted.has(fullName) || kind === 53)
          throw new Error("artifact_duplicate_or_nonregular_entry");
        extracted.set(fullName, tar.subarray(offset + 512, end));
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (!ended) throw new Error("artifact_tar_termination");
  } else if (spec.format === "zip") {
    // Central directory is mandatory. ZIP64, encryption, split archives and extra-field extensions refuse.
    let end = archive.length - 22;
    while (
      end >= Math.max(0, archive.length - 65557) &&
      (archive.readUInt32LE(end) !== 0x06054b50 ||
        end + 22 + archive.readUInt16LE(end + 20) !== archive.length)
    )
      end--;
    if (end < 0 || end < archive.length - 65557) throw new Error("artifact_invalid_zip");
    const count = archive.readUInt16LE(end + 10);
    const directorySize = archive.readUInt32LE(end + 12);
    const directoryOffset = archive.readUInt32LE(end + 16);
    if (
      archive.readUInt16LE(end + 4) ||
      archive.readUInt16LE(end + 6) ||
      archive.readUInt16LE(end + 8) !== count ||
      count === 65535 ||
      count > spec.maxMembers ||
      directoryOffset + directorySize !== end
    )
      throw new Error("artifact_invalid_zip");
    let cursor = directoryOffset;
    let expanded = 0;
    let previousEnd = 0;
    for (let member = 0; member < count; member++) {
      signal.throwIfAborted();
      if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
        throw new Error("artifact_invalid_zip");
      const flags = archive.readUInt16LE(cursor + 8);
      const method = archive.readUInt16LE(cursor + 10);
      const compressed = archive.readUInt32LE(cursor + 20);
      const size = archive.readUInt32LE(cursor + 24);
      const nameLength = archive.readUInt16LE(cursor + 28);
      const extra = archive.readUInt16LE(cursor + 30);
      const comment = archive.readUInt16LE(cursor + 32);
      const local = archive.readUInt32LE(cursor + 42);
      if (
        cursor + 46 + nameLength + extra + comment > end ||
        extra ||
        archive.readUInt16LE(cursor + 34) ||
        flags & ~0x808 ||
        ![0, 8].includes(method)
      )
        throw new Error("artifact_unsupported_zip");
      const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = archiveName(nameBytes);
      const mode = archive.readUInt32LE(cursor + 38) >>> 16;
      const kind = mode & 0o170000;
      if (
        (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) ||
        (kind === 0o040000 && !name.endsWith("/"))
      )
        throw new Error("artifact_unsafe_member");
      if (archive.readUInt32LE(cursor + 38) & 0x10 && !name.endsWith("/"))
        throw new Error("artifact_unsafe_member");
      expanded += size;
      if (expanded > spec.maxExpandedBytes) throw new Error("artifact_expanded_limit");
      if (
        local < previousEnd ||
        local + 30 > directoryOffset ||
        archive.readUInt32LE(local) !== 0x04034b50 ||
        archive.readUInt16LE(local + 6) !== flags ||
        archive.readUInt16LE(local + 8) !== method
      )
        throw new Error("artifact_invalid_zip_local");
      const localNameLength = archive.readUInt16LE(local + 26);
      const localExtra = archive.readUInt16LE(local + 28);
      const start = local + 30 + localNameLength + localExtra;
      if (
        localExtra ||
        start + compressed > directoryOffset ||
        !archive.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)
      )
        throw new Error("artifact_invalid_zip_local");
      previousEnd = start + compressed;
      const crc = archive.readUInt32LE(cursor + 16);
      if (flags & 8) {
        let descriptor = previousEnd;
        if (descriptor + 4 <= directoryOffset && archive.readUInt32LE(descriptor) === 0x08074b50)
          descriptor += 4;
        if (
          descriptor + 12 > directoryOffset ||
          archive.readUInt32LE(descriptor) !== crc ||
          archive.readUInt32LE(descriptor + 4) !== compressed ||
          archive.readUInt32LE(descriptor + 8) !== size
        )
          throw new Error("artifact_invalid_zip_descriptor");
        previousEnd = descriptor + 12;
      } else if (
        archive.readUInt32LE(local + 14) !== crc ||
        archive.readUInt32LE(local + 18) !== compressed ||
        archive.readUInt32LE(local + 22) !== size
      )
        throw new Error("artifact_invalid_zip_local");
      if (selected.has(name)) {
        if (extracted.has(name) || name.endsWith("/") || kind === 0o040000)
          throw new Error("artifact_duplicate_or_nonregular_entry");
        const executable =
          method === 0
            ? archive.subarray(start, start + compressed)
            : await expand(archive.subarray(start, start + compressed), "deflate", size, signal);
        if (executable.length !== size) throw new Error("artifact_zip_size");
        let actualCrc = 0xffffffff;
        for (let index = 0; index < executable.length; index++) {
          if ((index & 65535) === 0) checkDeadline();
          actualCrc ^= executable[index]!;
          for (let bit = 0; bit < 8; bit++)
            actualCrc = (actualCrc >>> 1) ^ (0xedb88320 & -(actualCrc & 1));
        }
        if ((actualCrc ^ 0xffffffff) >>> 0 !== crc) throw new Error("artifact_zip_crc");
        extracted.set(name, executable);
      }
      cursor += 46 + nameLength + extra + comment;
    }
    if (cursor !== end) throw new Error("artifact_invalid_zip");
  } else {
    throw new Error("artifact_unknown_format");
  }
  checkDeadline();
  for (const [path, hash] of selected) {
    const bytes = extracted.get(path);
    if (!bytes || !bytes.length || createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("artifact_entry_digest");
    checkDeadline();
  }
  const files: Record<string, Buffer> = Object.create(null);
  for (const [name, file] of Object.entries(spec.files ?? {}))
    files[name] = extracted.get(file.entry.join("/"))!;
  return { executable: extracted.get(wanted)!, files };
}

export async function acquireArtifact(
  specification: MachineArtifact,
  cache: HeldDirectory,
  authority: ArtifactAuthority,
): Promise<PinnedArtifact> {
  const spec = MachineArtifactSchema.parse(specification);
  if (
    !Number.isInteger(authority.maxRedirects) ||
    authority.maxRedirects < 0 ||
    authority.maxRedirects > 8 ||
    !Number.isInteger(authority.timeoutMs) ||
    authority.timeoutMs <= 0 ||
    authority.timeoutMs > 300000
  )
    throw new Error("artifact_authority_bounds");
  const root = cache.stat();
  if (root.uid !== process.getuid?.() || root.mode & 0o077)
    throw new Error("artifact_cache_not_private");
  const deadline = performance.now() + authority.timeoutMs;
  approvedUrl(spec.url, authority);
  try {
    const cached = openCachedArtifact(spec, cache);
    if (performance.now() >= deadline) {
      cached.close();
      throw new Error("artifact_deadline");
    }
    return cached;
  } catch (error) {
    // Only absence permits acquisition; a corrupt or substituted cache is not repaired silently.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
  const temporaryNames = new Set<string>();
  const held: number[] = [];
  let transferred = false;
  try {
    const archive = await download(spec, authority, controller.signal);
    const extracted = await extractArtifact(archive, spec, controller.signal, deadline);
    const files: Record<string, PinnedArtifactFile> = Object.create(null);
    const publications: { temporary: string; destination: string }[] = [];
    const entries = Object.entries(extracted.files).map(([name, bytes]) => ({
      name,
      bytes,
      hash: spec.files![name]!.sha256,
    }));
    // Primary is last: callers journal installation only after every file has been published.
    entries.push({ name: "", bytes: extracted.executable, hash: spec.entrySha256 });
    let primary: PinnedArtifactFile | undefined;
    for (const entry of entries) {
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("artifact_deadline");
      const temporary = `.artifact-${randomUUID()}`;
      const writable = cache.createFile(temporary);
      temporaryNames.add(temporary);
      try {
        let offset = 0;
        while (offset < entry.bytes.length) {
          controller.signal.throwIfAborted();
          if (performance.now() >= deadline) throw new Error("artifact_deadline");
          const count = writeSync(
            writable,
            entry.bytes,
            offset,
            Math.min(65536, entry.bytes.length - offset),
          );
          if (!count) throw new Error("artifact_short_write");
          offset += count;
        }
        fchmodSync(writable, 0o500);
        fsyncSync(writable);
        const fd = cache.openFile(temporary, constants.O_RDONLY);
        held.push(fd);
        const pinned = { fd, entrySha256: entry.hash, bytes: entry.bytes.length };
        if (entry.name) files[entry.name] = pinned;
        else primary = pinned;
        publications.push({ temporary, destination: `${spec.sha256}-${entry.hash}` });
      } finally {
        closeSync(writable);
      }
    }
    for (const publication of publications) {
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("artifact_deadline");
      cache.publish(publication.temporary, publication.destination);
      temporaryNames.delete(publication.temporary);
    }
    let closed = false;
    const result: PinnedArtifact = {
      ...primary!,
      archiveSha256: spec.sha256,
      files: Object.freeze(files),
      close() {
        if (!closed) {
          closed = true;
          for (const fd of held) closeSync(fd);
        }
      },
    };
    transferred = true;
    return result;
  } catch (error) {
    const errors: unknown[] = [error];
    for (const temporary of temporaryNames) {
      try {
        cache.unlink(temporary);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") errors.push(cleanup);
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, "artifact_cleanup_failed");
    throw error;
  } finally {
    clearTimeout(timer);
    if (!transferred) for (const fd of held) closeSync(fd);
  }
}

/** Recover only manifest-pinned executable bytes, through held cache descriptors. */
export function openCachedArtifact(
  specification: MachineArtifact,
  cache: HeldDirectory,
): PinnedArtifact {
  const spec = MachineArtifactSchema.parse(specification);
  const root = cache.stat();
  if (root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0)
    throw new Error("artifact_cache_not_private");
  if (spec.format === "raw" && Object.keys(spec.files ?? {}).length)
    throw new Error("artifact_raw_bundle");
  const entries = Object.entries(spec.files ?? {}).map(([name, file]) => ({
    name,
    hash: file.sha256,
    path: file.entry.join("/"),
  }));
  entries.push({ name: "", hash: spec.entrySha256, path: spec.entry.join("/") });
  const held: number[] = [];
  const files: Record<string, PinnedArtifactFile> = Object.create(null);
  const selected = new Map<string, string>();
  const scratch = Buffer.allocUnsafe(65536);
  let expanded = 0;
  let primary: PinnedArtifactFile | undefined;
  try {
    for (const entry of entries) {
      const fd = cache.openFile(`${spec.sha256}-${entry.hash}`, constants.O_RDONLY);
      held.push(fd);
      const before = fstatSync(fd);
      if (before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o500 || before.size <= 0)
        throw new Error("artifact_cache_identity");
      if (selected.has(entry.path) && selected.get(entry.path) !== entry.hash)
        throw new Error("artifact_conflicting_entry_digest");
      if (!selected.has(entry.path)) {
        expanded += before.size;
        selected.set(entry.path, entry.hash);
      }
      if (
        expanded > spec.maxExpandedBytes ||
        (spec.format === "raw" && before.size > spec.maxBytes)
      )
        throw new Error("artifact_expanded_limit");
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < before.size) {
        const count = readSync(
          fd,
          scratch,
          0,
          Math.min(scratch.length, before.size - offset),
          offset,
        );
        if (!count) throw new Error("artifact_cache_changed");
        hash.update(scratch.subarray(0, count));
        offset += count;
      }
      const after = fstatSync(fd);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        after.nlink !== 1 ||
        after.mode !== before.mode
      )
        throw new Error("artifact_cache_changed");
      if (hash.digest("hex") !== entry.hash) throw new Error("artifact_entry_digest");
      const pinned = { fd, entrySha256: entry.hash, bytes: before.size };
      if (entry.name) files[entry.name] = pinned;
      else primary = pinned;
    }
    let closed = false;
    return {
      ...primary!,
      archiveSha256: spec.sha256,
      files: Object.freeze(files),
      close() {
        if (!closed) {
          closed = true;
          for (const fd of held) closeSync(fd);
        }
      },
    };
  } catch (error) {
    for (const fd of held) closeSync(fd);
    throw error;
  }
}
