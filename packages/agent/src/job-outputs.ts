import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { JobRequest, JobResult } from "@manifold/protocol";
import type { HeldDirectory } from "./job-files.ts";
import { directoryAncestry, fdMountId, safeComponent } from "./job-files.ts";

type Output = JobResult["outputs"][number];
type Binding = JobRequest["outputs"][number];
export interface OutputSealProof {
  workloadEmpty: true;
  writersReleased: true;
}
interface Sealed {
  jobId: string;
  output: Output;
  fd: number;
  encoding: "ustar" | "raw";
}
export interface JobOutputByteStream {
  readonly outputId: string;
  write(bytes: Uint8Array): void;
  seal(proof: OutputSealProof): Output;
  abort(): void;
}
const MAX_BYTES = 1073741824;
const MAX_ENTRIES = 10000;
const component = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function checkComponent(value: string): void {
  if (!component.test(value) || value === "." || value === "..")
    throw new Error("invalid_output_component");
}
function unchanged(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function identity(directory: HeldDirectory, name: string, before: Stats): void {
  if (!unchanged(before, lstatSync(`${directory.procPath}/${name}`)))
    throw new Error("output_changed");
}
function names(directory: HeldDirectory, budget: { entries: number }): string[] {
  const stream = opendirSync(directory.procPath);
  const result: string[] = [];
  try {
    for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      if (++budget.entries > MAX_ENTRIES) throw new Error("output_entry_limit");
      // Unlike declared binding components, payload names may include dotfiles/spaces.
      safeComponent(entry.name);
      result.push(entry.name);
    }
  } finally {
    stream.closeSync();
  }
  return result.sort();
}
/** Canonical POSIX ustar: regular files only, lexical traversal, mode 0600,
 * uid/gid/mtime zero, no extension records. Empty directories are omitted.
 * Output bytes and SHA256 describe this archive, not concatenated file payloads. */
function header(path: string, size: number): Buffer {
  const bytes = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const splits = [...path.matchAll(/\//g)].map((match) => match.index!);
    const split = splits.findLast(
      (index) =>
        Buffer.byteLength(path.slice(0, index)) <= 155 &&
        Buffer.byteLength(path.slice(index + 1)) <= 100,
    );
    if (split === undefined) throw new Error("output_archive_path_limit");
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  bytes.write(name, 0, 100, "utf8");
  const octal = (value: number, offset: number, length: number) =>
    bytes.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
  octal(0o600, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  bytes.fill(32, 148, 156);
  bytes[156] = 48;
  bytes.write("ustar\0", 257, 6, "ascii");
  bytes.write("00", 263, 2, "ascii");
  bytes.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of bytes) sum += byte;
  bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return bytes;
}

export class JobOutputLease {
  readonly mount: { fd: number; path: string };
  private writers = 0;
  private readonly writerWaiters = new Set<() => void>();
  private active = true;
  constructor(
    readonly jobId: string,
    readonly outputId: string,
    readonly name: string,
    readonly directory: HeldDirectory,
    readonly maxBytes: number,
  ) {
    this.mount = { fd: directory.fd, path: directory.procPath };
  }
  retainWriter(): () => void {
    if (!this.active) throw new Error("output_lease_inactive");
    this.writers++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.writers--;
        if (this.writers === 0) {
          for (const resolve of this.writerWaiters) resolve();
          this.writerWaiters.clear();
        }
      }
    };
  }
  get writersReleased(): boolean {
    return this.writers === 0;
  }
  waitForWriters(): Promise<void> {
    if (this.writers === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.writerWaiters.add(resolve);
    return promise;
  }
  assertSealable(proof: OutputSealProof): void {
    if (
      !this.active ||
      proof?.workloadEmpty !== true ||
      proof?.writersReleased !== true ||
      this.writers !== 0
    )
      throw new Error("output_writers_active");
  }
  finish(): void {
    this.active = false;
    this.directory.close();
  }
}

interface OutputWriter {
  readonly fd: number;
  readonly parentFd: number | undefined;
  readonly releases: Map<JobOutputLease, () => void>;
  readonly preparation: object | undefined;
}

/** The owner supplies a private, trusted-writer store which is never mounted in jobs.
 * This class borrows that store handle; close() closes only its own sealed file fds.
 * Authorization and durable job deduplication remain the owner's responsibility. */
export class JobOutputStore {
  private readonly active = new Map<string, JobOutputLease>();
  private readonly streams = new Map<string, { jobId: string; name: string }>();
  private readonly sealed = new Map<string, Sealed>();
  private readonly writers = new Set<OutputWriter>();
  private closed = false;
  private constructor(private readonly directory: HeldDirectory) {}
  static open(directory: HeldDirectory): JobOutputStore {
    const stat = directory.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("output_store_not_private");
    const store = new JobOutputStore(directory);
    try {
      store.recover();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }
  private ensureOpen(): void {
    if (this.closed) throw new Error("output_store_closed");
  }
  /** mkdir cannot atomically return its new descriptor. Exclude authorized ancestor
   * writers during create-only resolution, so none can substitute an old target. */
  assertCreateAllowed(parentFd: number, preparation?: object): void {
    const ancestors = directoryAncestry(parentFd);
    for (const writer of this.writers) {
      if (preparation !== undefined && writer.preparation === preparation) continue;
      const stat = fstatSync(writer.fd, { bigint: true });
      if (stat.isDirectory() && ancestors.includes(`${stat.dev}:${stat.ino}`))
        throw new Error("create_location_writer_active");
    }
  }
  /** Refresh held inode membership too: a file can move without its original parent. */
  async waitForWriters(leases: readonly JobOutputLease[]): Promise<void> {
    for (;;) {
      for (const lease of leases) this.refreshWriters(lease);
      if (leases.every((lease) => lease.writersReleased)) return;
      await Promise.all(leases.map((lease) => lease.waitForWriters()));
    }
  }
  /** Register before any process can receive writable mounts; release only on empty proof.
   * Descriptors remain borrowed from the owner's live job until the returned release runs. */
  retainWriter(fd: number, parentFd?: number, preparation?: object): () => void {
    this.ensureOpen();
    const writer: OutputWriter = { fd, parentFd, preparation, releases: new Map() };
    if (!fstatSync(fd).isDirectory() && parentFd === undefined)
      throw new Error("writer_parent_required");
    try {
      for (const lease of this.active.values()) this.attachWriter(writer, lease);
      this.writers.add(writer);
    } catch (error) {
      for (const release of writer.releases.values()) release();
      throw error;
    }
    return () => {
      if (!this.writers.delete(writer)) return;
      for (const release of writer.releases.values()) release();
      writer.releases.clear();
    };
  }
  private outputFileIdentities(lease: JobOutputLease): ReadonlySet<string> {
    const identities = new Set<string>();
    const budget = { entries: 0 };
    const walk = (directory: HeldDirectory, depth: number): void => {
      if (depth > 16) throw new Error("output_depth_limit");
      const start = directory.stat();
      for (const name of names(directory, budget)) {
        const before = lstatSync(`${directory.procPath}/${name}`, { bigint: true });
        if (before.isDirectory()) {
          const child = directory.openChild(name);
          try {
            const held = fstatSync(child.fd, { bigint: true });
            if (held.dev !== before.dev || held.ino !== before.ino)
              throw new Error("output_changed");
            walk(child, depth + 1);
          } finally {
            child.close();
          }
        } else if (before.isFile()) {
          identities.add(`${before.dev}:${before.ino}`);
        }
      }
      if (!unchanged(start, directory.stat())) throw new Error("output_changed");
    };
    walk(lease.directory, 0);
    return identities;
  }
  private refreshWriters(lease: JobOutputLease): void {
    let identities: ReadonlySet<string> | undefined;
    const files = () => (identities ??= this.outputFileIdentities(lease));
    for (const writer of this.writers) this.attachWriter(writer, lease, files);
  }
  private attachWriter(
    writer: OutputWriter,
    lease: JobOutputLease,
    files = () => this.outputFileIdentities(lease),
  ): void {
    if (writer.releases.has(lease)) return;
    const stat = fstatSync(writer.fd, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    const outputAncestors = directoryAncestry(lease.directory.fd);
    const overlaps = stat.isDirectory()
      ? outputAncestors.includes(identity) ||
        directoryAncestry(writer.fd).includes(outputAncestors[0]!)
      : directoryAncestry(writer.parentFd!).includes(outputAncestors[0]!) || files().has(identity);
    // Once observed, retain the writer until its actual empty-proof release, even if renamed again.
    if (overlaps) writer.releases.set(lease, lease.retainWriter());
  }
  createByteStream(
    jobId: string,
    name: "stdout" | "stderr",
    maxBytes: number,
  ): JobOutputByteStream {
    this.ensureOpen();
    if (
      !jobId ||
      jobId.length > 256 ||
      (name !== "stdout" && name !== "stderr") ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_BYTES
    )
      throw new Error("invalid_output_stream");
    for (const item of this.streams.values())
      if (item.jobId === jobId && item.name === name) throw new Error("output_name_collision");
    for (const item of this.sealed.values())
      if (item.jobId === jobId && item.output.name === name)
        throw new Error("output_name_collision");
    const outputId = randomUUID();
    const temporary = `.stage-${outputId}`;
    const fd = this.directory.createFile(temporary);
    this.streams.set(outputId, { jobId, name });
    const hash = createHash("sha256");
    let bytes = 0;
    let finished = false;
    let failed = false;
    let published = false;
    return {
      outputId,
      write: (data) => {
        if (finished || failed) throw new Error("output_stream_inactive");
        try {
          if (bytes + data.byteLength > maxBytes) throw new Error("output_byte_limit");
          let offset = 0;
          while (offset < data.byteLength) {
            const n = writeSync(fd, data, offset, data.byteLength - offset);
            if (!n) throw new Error("short_output_write");
            offset += n;
          }
          hash.update(data);
          bytes += data.byteLength;
        } catch (error) {
          failed = true;
          throw error;
        }
      },
      seal: (proof) => {
        if (finished || failed) throw new Error("output_stream_inactive");
        if (proof?.workloadEmpty !== true || proof?.writersReleased !== true)
          throw new Error("output_writers_active");
        try {
          const output: Output = { outputId, name, sha256: hash.digest("hex"), bytes, files: 1 };
          fchmodSync(fd, 0o400);
          fsyncSync(fd);
          this.directory.publish(temporary, `${outputId}.raw`);
          published = true;
          const readFd = this.directory.openFile(`${outputId}.raw`);
          try {
            this.directory.atomicWrite(
              `${outputId}.json`,
              JSON.stringify({ jobId, output, encoding: "raw" }),
            );
            this.sealed.set(outputId, { jobId, output, fd: readFd, encoding: "raw" });
          } catch (error) {
            closeSync(readFd);
            throw error;
          }
          closeSync(fd);
          finished = true;
          this.streams.delete(outputId);
          return { ...output };
        } catch (error) {
          failed = true;
          throw error;
        }
      },
      abort: () => {
        if (finished) return;
        closeSync(fd);
        finished = true;
        this.streams.delete(outputId);
        this.directory.unlink(published ? `${outputId}.raw` : temporary);
        fsyncSync(this.directory.fd);
      },
    };
  }
  create(
    jobId: string,
    binding: Binding,
    admittedWritable: HeldDirectory,
    maxBytes: number,
  ): JobOutputLease {
    this.ensureOpen();
    checkComponent(binding.name);
    if (binding.name === "stdout" || binding.name === "stderr")
      throw new Error("output_name_collision");
    if (
      !jobId ||
      jobId.length > 256 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1024 ||
      maxBytes > MAX_BYTES ||
      binding.components.length < 1 ||
      binding.components.length > 16
    )
      throw new Error("invalid_output_lease");
    for (const part of binding.components) checkComponent(part);
    const parents: HeldDirectory[] = [];
    let parent = admittedWritable;
    try {
      for (const part of binding.components.slice(0, -1)) {
        parent = parent.openChild(part);
        parents.push(parent);
      }
      const leaf = binding.components[binding.components.length - 1]!;
      // Exclusive creation refuses pre-existing directories, links and stale output trees.
      mkdirSync(`${parent.procPath}/${leaf}`, { mode: 0o700 });
      const before = lstatSync(`${parent.procPath}/${leaf}`);
      const directory = parent.openChild(leaf);
      try {
        if (!unchanged(before, directory.stat())) throw new Error("output_changed");
        const lease = new JobOutputLease(jobId, randomUUID(), binding.name, directory, maxBytes);
        try {
          this.refreshWriters(lease);
        } catch (error) {
          for (const writer of this.writers) {
            writer.releases.get(lease)?.();
            writer.releases.delete(lease);
          }
          throw error;
        }
        this.active.set(lease.outputId, lease);
        return lease;
      } catch (error) {
        directory.close();
        throw error;
      }
    } finally {
      for (const directory of parents.reverse()) directory.close();
    }
  }
  seal(lease: JobOutputLease, proof: OutputSealProof, remainingBytes = lease.maxBytes): Output {
    this.ensureOpen();
    if (this.active.get(lease.outputId) !== lease) throw new Error("unknown_output_lease");
    this.refreshWriters(lease);
    lease.assertSealable(proof);
    const maxBytes = Math.min(lease.maxBytes, remainingBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("output_byte_limit");
    const temporary = `.stage-${lease.outputId}`;
    const fd = this.directory.createFile(temporary);
    let published = false;
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      let files = 0;
      const buffer = Buffer.allocUnsafe(65536);
      const zero = Buffer.alloc(1024);
      const budget = { entries: 0 };
      const append = (data: Buffer) => {
        if (bytes + data.length > maxBytes) throw new Error("output_byte_limit");
        let offset = 0;
        while (offset < data.length) {
          const n = writeSync(fd, data, offset, data.length - offset);
          if (n === 0) throw new Error("short_output_write");
          offset += n;
        }
        bytes += data.length;
        hash.update(data);
      };
      const walk = (directory: HeldDirectory, prefix: string, depth: number) => {
        if (depth > 16) throw new Error("output_depth_limit");
        const start = directory.stat();
        for (const name of names(directory, budget)) {
          const path = prefix ? `${prefix}/${name}` : name;
          // lstat chooses the kind only; the actual read always uses a checked held fd.
          const before = lstatSync(`${directory.procPath}/${name}`);
          if (before.isDirectory()) {
            const child = directory.openChild(name);
            try {
              if (!unchanged(before, child.stat())) throw new Error("output_changed");
              walk(child, path, depth + 1);
              identity(directory, name, before);
            } finally {
              child.close();
            }
          } else {
            if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe_output_entry");
            const input = directory.openFile(name);
            try {
              const initial = fstatSync(input);
              if (!unchanged(before, initial)) throw new Error("output_changed");
              if (512 + Math.ceil(initial.size / 512) * 512 + 1024 > maxBytes - bytes)
                throw new Error("output_byte_limit");
              append(header(path, initial.size));
              let offset = 0;
              while (offset < initial.size) {
                const n = readSync(
                  input,
                  buffer,
                  0,
                  Math.min(buffer.length, initial.size - offset),
                  offset,
                );
                if (!n) throw new Error("output_changed");
                append(buffer.subarray(0, n));
                offset += n;
              }
              if (!unchanged(initial, fstatSync(input)) || fdMountId(input) !== directory.mountId)
                throw new Error("output_changed");
              identity(directory, name, initial);
              append(zero.subarray(0, (512 - (initial.size % 512)) % 512));
              files++;
            } finally {
              closeSync(input);
            }
          }
        }
        if (!unchanged(start, directory.stat())) throw new Error("output_changed");
      };
      walk(lease.directory, "", 0);
      append(zero);
      const output: Output = {
        outputId: lease.outputId,
        name: lease.name,
        sha256: hash.digest("hex"),
        bytes,
        files,
      };
      fchmodSync(fd, 0o400);
      fsyncSync(fd);
      this.directory.publish(temporary, `${lease.outputId}.tar`);
      published = true;
      const readFd = this.directory.openFile(`${lease.outputId}.tar`);
      try {
        this.directory.atomicWrite(
          `${lease.outputId}.json`,
          JSON.stringify({ jobId: lease.jobId, output, encoding: "ustar" }),
        );
        this.sealed.set(lease.outputId, {
          jobId: lease.jobId,
          output,
          fd: readFd,
          encoding: "ustar",
        });
      } catch (error) {
        closeSync(readFd);
        throw error;
      }
      lease.finish();
      this.active.delete(lease.outputId);
      return { ...output };
    } catch (error) {
      if (!published) {
        try {
          this.directory.unlink(temporary);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
            throw new AggregateError([error, cleanup], "output_cleanup_failed");
        }
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  /** Failure teardown does not remove or seal untrusted trees and claims no writer proof. */
  abort(lease: JobOutputLease): void {
    if (this.active.get(lease.outputId) !== lease) throw new Error("unknown_output_lease");
    lease.finish();
    this.active.delete(lease.outputId);
  }
  recovered(jobId: string): Output[] {
    this.ensureOpen();
    return [...this.sealed.values()]
      .filter((item) => item.jobId === jobId)
      .map((item) => ({ ...item.output }));
  }
  read(
    jobId: string,
    outputId: string,
    offset: number,
    maxBytes: number,
  ): { data: Buffer; eof: boolean } {
    this.ensureOpen();
    const item = this.sealed.get(outputId);
    if (!item || item.jobId !== jobId) throw new Error("unknown_job_output");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > item.output.bytes ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 65536
    )
      throw new Error("invalid_output_read");
    const data = Buffer.allocUnsafe(Math.min(maxBytes, item.output.bytes - offset));
    let count = 0;
    while (count < data.length) {
      const n = readSync(item.fd, data, count, data.length - count, offset + count);
      if (!n) throw new Error("sealed_output_corrupt");
      count += n;
    }
    return { data, eof: offset + count === item.output.bytes };
  }
  release(jobId: string, outputId: string): void {
    this.ensureOpen();
    if (this.active.has(outputId) || this.streams.has(outputId))
      throw new Error("output_lease_active");
    const item = this.sealed.get(outputId);
    if (!item || item.jobId !== jobId) throw new Error("unknown_job_output");
    // Remove durable visibility first; a crash can leave only an inaccessible orphan.
    this.directory.unlink(`${outputId}.json`);
    fsyncSync(this.directory.fd);
    closeSync(item.fd);
    this.sealed.delete(outputId);
    this.directory.unlink(`${outputId}.${item.encoding === "raw" ? "raw" : "tar"}`);
    fsyncSync(this.directory.fd);
  }
  close(): void {
    if (this.active.size || this.streams.size) throw new Error("output_leases_active");
    for (const item of this.sealed.values()) closeSync(item.fd);
    this.sealed.clear();
    this.closed = true;
  }
  private recover(): void {
    const stream = opendirSync(this.directory.procPath);
    const buffer = Buffer.allocUnsafe(65536);
    try {
      for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
        if (!/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
        const metadata = this.directory.openFile(entry.name);
        let record: { jobId: string; output: Output; encoding: string };
        try {
          const size = fstatSync(metadata).size;
          if (size > 4096) throw new Error("invalid_output_index");
          const data = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const n = readSync(metadata, data, offset, size - offset, offset);
            if (!n) throw new Error("invalid_output_index");
            offset += n;
          }
          record = JSON.parse(data.toString("utf8"));
        } finally {
          closeSync(metadata);
        }
        const output = record.output;
        if (
          (record.encoding !== "ustar" && record.encoding !== "raw") ||
          typeof record.jobId !== "string" ||
          !record.jobId ||
          record.jobId.length > 256 ||
          !output ||
          output.outputId !== entry.name.slice(0, -5) ||
          typeof output.name !== "string" ||
          !/^[a-f0-9]{64}$/.test(output.sha256) ||
          !Number.isSafeInteger(output.bytes) ||
          output.bytes < (record.encoding === "ustar" ? 1024 : 0) ||
          output.bytes > MAX_BYTES ||
          !Number.isSafeInteger(output.files) ||
          output.files < 0 ||
          output.files > MAX_ENTRIES
        )
          throw new Error("invalid_output_index");
        if (
          record.encoding === "raw" &&
          (output.files !== 1 || (output.name !== "stdout" && output.name !== "stderr"))
        )
          throw new Error("invalid_output_index");
        checkComponent(output.name);
        const fd = this.directory.openFile(
          `${output.outputId}.${record.encoding === "raw" ? "raw" : "tar"}`,
        );
        try {
          const stat = fstatSync(fd);
          if (
            stat.size !== output.bytes ||
            (stat.mode & 0o222) !== 0 ||
            stat.uid !== process.getuid?.()
          )
            throw new Error("sealed_output_corrupt");
          const hash = createHash("sha256");
          let offset = 0;
          while (offset < stat.size) {
            const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            if (!n) throw new Error("sealed_output_corrupt");
            hash.update(buffer.subarray(0, n));
            offset += n;
          }
          if (hash.digest("hex") !== output.sha256 || !unchanged(stat, fstatSync(fd)))
            throw new Error("sealed_output_corrupt");
          this.sealed.set(output.outputId, {
            jobId: record.jobId,
            output,
            fd,
            encoding: record.encoding,
          });
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      }
    } finally {
      stream.closeSync();
    }
  }
}
