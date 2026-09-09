import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  writeSync,
  readSync,
  fstatSync,
} from "node:fs";
import {
  MachineArtifactSchema,
  canonicalJobJson,
  type MachineArtifact,
  type JobArtifactDelivery,
} from "@manifold/protocol";
import { deliveredArtifact, extractArtifact } from "@manifold/plugin-kit/artifacts";
import type { HeldDirectory } from "./job-files.ts";

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
export interface PinnedArtifact {
  /** Read-only executable fd; caller owns close(). Never reopen its published pathname. */
  fd: number;
  archiveSha256: string;
  entrySha256: string;
  bytes: number;
  readonly files: Readonly<Record<string, PinnedArtifactFile>>;
  close(): void;
}

/** Layout identity is distinct from archive identity: equal bytes do not authorize new entries. */
export function artifactCacheKey(spec: MachineArtifact, entrySha256: string): string {
  const layout = {
    sha256: spec.sha256,
    format: spec.format,
    entry: spec.entry,
    entrySha256: spec.entrySha256,
    files: spec.files ?? {},
  };
  return `${createHash("sha256").update(canonicalJobJson(layout)).digest("hex")}-${entrySha256}`;
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
  if (artifact.url === undefined) throw new Error("artifact_url_missing");
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

export async function acquireArtifact(
  specification: MachineArtifact,
  cache: HeldDirectory,
  authority: ArtifactAuthority,
  delivery?: JobArtifactDelivery,
  archives?: Map<string, Buffer>,
  decoded?: Map<string, Buffer>,
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
  if (spec.url !== undefined) approvedUrl(spec.url, authority);
  const supplied = deliveredArtifact(spec, delivery, decoded);
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
    const sourceKey = `${spec.url ?? spec.bundleFile}\0${spec.sha256}`;
    const archive =
      archives?.get(sourceKey) ?? supplied ?? (await download(spec, authority, controller.signal));
    if (archive.length > spec.maxBytes) throw new Error("artifact_compressed_limit");
    if (archives && !archives.has(sourceKey)) {
      // The owner groups equal sources. Retain at most one bounded archive, including
      // large managed runtimes, while verifying/publishing each selected layout separately.
      archives.clear();
      archives.set(sourceKey, archive);
    }
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
        publications.push({ temporary, destination: artifactCacheKey(spec, entry.hash) });
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
      const fd = cache.openFile(artifactCacheKey(spec, entry.hash), constants.O_RDONLY);
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
