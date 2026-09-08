import { createHash } from "node:crypto";
import { createGunzip, createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { JobArtifactDeliverySchema, MachineArtifactSchema, type MachineArtifact, type PluginBundle, type JobArtifactDelivery } from "@manifold/protocol";

export interface ExtractedArtifact {
  executable: Buffer;
  files: Readonly<Record<string, Buffer>>;
}

/** Verify transport presence and identity before cache lookup, even for an already installed worker. */
export function deliveredArtifact(spec: MachineArtifact, delivery: JobArtifactDelivery | undefined): Buffer | undefined {
  if (spec.bundleFile === undefined) {
    if (delivery !== undefined) throw new Error("artifact_unexpected_delivery");
    return undefined;
  }
  if (!delivery) throw new Error("artifact_bundle_unavailable");
  if (delivery.bundleFile !== spec.bundleFile) throw new Error("artifact_bundle_member_mismatch");
  delivery = JobArtifactDeliverySchema.parse(delivery);
  const size = delivery.data.length / 4 * 3 - (delivery.data.endsWith("==") ? 2 : delivery.data.endsWith("=") ? 1 : 0);
  if (!size || size > spec.maxBytes) throw new Error("artifact_compressed_limit");
  const bytes = Buffer.from(delivery.data, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256) throw new Error("artifact_archive_digest");
  return bytes;
}

/** Reuses the owner archive verifier: admission and packing never have a second extractor. */
export async function verifyBundledArtifacts(bundle: PluginBundle): Promise<void> {
  const signal = AbortSignal.timeout(30000);
  const deadline = performance.now() + 30000;
  for (const spec of Object.values(bundle.manifest.machine?.artifacts ?? {})) {
    if (spec.bundleFile === undefined) continue;
    const archive = deliveredArtifact(spec, { bundleFile: spec.bundleFile, data: bundle.files[spec.bundleFile]! })!;
    await extractArtifact(archive, spec, signal, deadline);
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
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part) || Buffer.byteLength(part) > 255))
    throw new Error("unsafe_file_component");
  return name;
}
function octal(bytes: Buffer): number {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("artifact_invalid_tar_number");
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("artifact_invalid_tar_number");
  return value;
}
/** One bounded archive verifier for packing, hub admission, and native owner acquisition. */
export async function extractArtifact(
  archive: Buffer,
  spec: MachineArtifact,
  signal: AbortSignal,
  deadline = Infinity,
): Promise<ExtractedArtifact> {
  spec = MachineArtifactSchema.parse(spec);
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("artifact_deadline");
  };
  checkDeadline();
  if (archive.length > spec.maxBytes) throw new Error("artifact_compressed_limit");
  if (createHash("sha256").update(archive).digest("hex") !== spec.sha256)
    throw new Error("artifact_archive_digest");
  const wanted = spec.entry.join("/");
  const selected = new Map<string, string>([[wanted, spec.entrySha256]]);
  const extracted = new Map<string, Buffer>();
  for (const file of Object.values(spec.files ?? {})) {
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
