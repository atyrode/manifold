import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import {
  constants,
  closeSync,
  chmodSync,
  fchmodSync,
  fsyncSync,
  writeSync,
  readSync,
  fstatSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import {
  MachineArtifactSchema,
  MachineArtifactFileGroupSchema,
  ManagedToolArtifactSchema,
  canonicalJobJson,
  type MachineArtifact,
  type MachineArtifactFileGroupSource,
  type MachineArtifactFileGroup,
  type ManagedToolArtifact,
  type JobArtifactDelivery,
} from "@manifold/protocol";
import {
  deliveredArtifact,
  extractArtifact,
  isPublicArtifactAddress,
} from "@manifold/plugin-kit/artifacts";
import { safeComponent, type HeldDirectory } from "./job-files.ts";
import type { LinuxJobBind } from "./job-linux.ts";

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

/** Trusted, constructor-only source bytes. Keys are the exact URL, NUL, and archive SHA256. */
export type PreparedArtifactArchives = ReadonlyMap<string, Uint8Array>;

export interface ManagedToolAcquisitionOptions {
  delivery?: JobArtifactDelivery;
  toolArtifacts?: Readonly<Record<string, string>>;
  preparedArtifactArchives?: PreparedArtifactArchives;
  archives?: Map<string, Buffer>;
  decoded?: Map<string, Buffer>;
}

export interface PinnedManagedTool extends PinnedArtifact {
  readonly binds: readonly LinuxJobBind[];
}

type ArtifactSource = MachineArtifact | MachineArtifactFileGroupSource;

/** Prepared bytes never grant URL authority and are checked even when selected files are cached. */
function preparedArtifact(
  spec: ArtifactSource,
  prepared: PreparedArtifactArchives | undefined,
): Buffer | undefined {
  if (spec.url === undefined) return undefined;
  const value = prepared?.get(`${spec.url}\0${spec.sha256}`);
  if (value === undefined) return undefined;
  if (!value.byteLength || value.byteLength > spec.maxBytes)
    throw new Error("artifact_compressed_limit");
  if (createHash("sha256").update(value).digest("hex") !== spec.sha256)
    throw new Error("artifact_archive_digest");
  // Retain the caller-owned storage; do not duplicate large trusted archives.
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function closeArtifactFds(fds: readonly number[]): void {
  const errors: unknown[] = [];
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "artifact_close_failed");
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
  artifact: ArtifactSource,
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
  preparedArtifactArchives?: PreparedArtifactArchives,
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
  const prepared = preparedArtifact(spec, preparedArtifactArchives);
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
      prepared ??
      archives?.get(sourceKey) ??
      supplied ??
      (await download(spec, authority, controller.signal));
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
          closeArtifactFds(held);
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
    try {
      closeArtifactFds(held);
    } catch (cleanup) {
      errors.push(cleanup);
    }
    held.length = 0;
    if (errors.length > 1) throw new AggregateError(errors, "artifact_cleanup_failed");
    throw error;
  } finally {
    clearTimeout(timer);
    if (!transferred) closeArtifactFds(held);
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
          closeArtifactFds(held);
        }
      },
    };
  } catch (error) {
    try {
      closeArtifactFds(held);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "artifact_close_failed");
    }
    throw error;
  }
}

/** Seals source authority, selected layout, destinations and budgets into one cache identity. */
export function managedToolGroupCacheKey(specification: MachineArtifactFileGroup): string {
  const group = MachineArtifactFileGroupSchema.parse(specification);
  return `managed-group-${createHash("sha256").update(canonicalJobJson(group)).digest("hex")}`;
}

interface GroupFile {
  target: readonly string[];
  hash: string;
  bytes?: Buffer;
}
interface GroupTree {
  directories: Map<string, GroupTree>;
  files: Map<string, GroupFile>;
}

function groupTree(group: MachineArtifactFileGroup): GroupTree {
  const tree: GroupTree = { directories: new Map(), files: new Map() };
  const files: GroupFile[] = [
    { target: group.entryTarget, hash: group.artifact.entrySha256 },
    ...Object.entries(group.artifact.files ?? {}).map(([id, file]) => ({
      target: group.fileTargets[id]!,
      hash: file.sha256,
    })),
  ];
  for (const file of files) {
    let parent = tree;
    for (const component of file.target.slice(0, -1)) {
      if (parent.files.has(component)) throw new Error("artifact_group_target_collision");
      let child = parent.directories.get(component);
      if (!child) {
        child = { directories: new Map(), files: new Map() };
        parent.directories.set(component, child);
      }
      parent = child;
    }
    const name = file.target.at(-1)!;
    if (parent.files.has(name) || parent.directories.has(name))
      throw new Error("artifact_group_target_collision");
    parent.files.set(name, file);
  }
  return tree;
}

function assertGroupDirectory(directory: HeldDirectory): void {
  const stat = directory.stat();
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o500)
    throw new Error("artifact_group_cache_identity");
}

/** Complete-tree recovery never follows a link or tolerates an unselected entry. */
function verifyGroupTree(
  directory: HeldDirectory,
  tree: GroupTree,
  spec: MachineArtifactFileGroupSource,
  checkDeadline?: () => void,
): void {
  const scratch = Buffer.allocUnsafe(65536);
  let expanded = 0;
  function visit(parent: HeldDirectory, expected: GroupTree): void {
    checkDeadline?.();
    assertGroupDirectory(parent);
    const before = parent.stat();
    let count = 0;
    for (const name of readdirSync(parent.procPath, { encoding: "buffer" })) {
      const text = name.toString("utf8");
      if (
        !Buffer.from(text).equals(name) ||
        (!expected.files.has(text) && !expected.directories.has(text))
      )
        throw new Error("artifact_group_cache_extra_entry");
      const stat = lstatSync(Buffer.concat([Buffer.from(`${parent.procPath}/`), name]));
      if (
        (expected.files.has(text) && !stat.isFile()) ||
        (expected.directories.has(text) && !stat.isDirectory())
      )
        throw new Error("artifact_group_cache_extra_entry");
      count++;
    }
    if (count !== expected.files.size + expected.directories.size)
      throw new Error("artifact_group_cache_incomplete");
    for (const [name, file] of expected.files) {
      checkDeadline?.();
      const fd = parent.openFile(name, constants.O_RDONLY);
      try {
        const beforeFile = fstatSync(fd);
        if (
          beforeFile.uid !== process.getuid?.() ||
          (beforeFile.mode & 0o7777) !== 0o400 ||
          beforeFile.size <= 0
        )
          throw new Error("artifact_group_cache_identity");
        expanded += beforeFile.size;
        if (
          expanded > spec.maxExpandedBytes ||
          (spec.format === "raw" && beforeFile.size > spec.maxBytes)
        )
          throw new Error("artifact_expanded_limit");
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < beforeFile.size) {
          checkDeadline?.();
          const count = readSync(
            fd,
            scratch,
            0,
            Math.min(scratch.length, beforeFile.size - offset),
            offset,
          );
          if (!count) throw new Error("artifact_cache_changed");
          hash.update(scratch.subarray(0, count));
          offset += count;
        }
        const after = fstatSync(fd);
        if (
          after.size !== beforeFile.size ||
          after.mtimeMs !== beforeFile.mtimeMs ||
          after.ctimeMs !== beforeFile.ctimeMs ||
          after.mode !== beforeFile.mode ||
          after.uid !== beforeFile.uid ||
          after.gid !== beforeFile.gid ||
          after.nlink !== 1
        )
          throw new Error("artifact_cache_changed");
        if (hash.digest("hex") !== file.hash) throw new Error("artifact_entry_digest");
      } finally {
        closeSync(fd);
      }
    }
    for (const [name, childTree] of expected.directories) {
      const child = parent.openDirectoryEntry(Buffer.from(name));
      try {
        visit(child, childTree);
        parent.assertDirectoryEntry(Buffer.from(name), child);
      } finally {
        child.close();
      }
    }
    const after = parent.stat();
    if (
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid
    )
      throw new Error("artifact_cache_changed");
  }
  visit(directory, tree);
}

function openCachedGroup(
  group: MachineArtifactFileGroup,
  cache: HeldDirectory,
  checkDeadline?: () => void,
): HeldDirectory {
  // Only absence of the entire published root permits acquisition, never a partial tree.
  const directory = cache.openChild(managedToolGroupCacheKey(group));
  try {
    verifyGroupTree(directory, groupTree(group), group.artifact, checkDeadline);
    cache.assertDirectoryEntry(Buffer.from(managedToolGroupCacheKey(group)), directory);
    checkDeadline?.();
    return directory;
  } catch (error) {
    const failure = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? new Error("artifact_group_cache_incomplete", { cause: error })
      : error;
    return failManagedResources(undefined, [directory], failure);
  }
}

function sourceDelivery(
  spec: ArtifactSource,
  options: ManagedToolAcquisitionOptions,
): JobArtifactDelivery | undefined {
  if (spec.bundleFile === undefined) return undefined;
  if (options.delivery?.bundleFile === spec.bundleFile) return options.delivery;
  const data = options.toolArtifacts?.[spec.bundleFile];
  return data === undefined ? undefined : { bundleFile: spec.bundleFile, data };
}

async function acquireGroup(
  group: MachineArtifactFileGroup,
  cache: HeldDirectory,
  authority: ArtifactAuthority,
  options: ManagedToolAcquisitionOptions,
): Promise<HeldDirectory> {
  const spec = group.artifact;
  const deadline = performance.now() + authority.timeoutMs;
  const checkDeadline = () => {
    if (performance.now() >= deadline) throw new Error("artifact_deadline");
  };
  if (spec.url !== undefined) approvedUrl(spec.url, authority);
  const supplied = deliveredArtifact(spec, sourceDelivery(spec, options), options.decoded);
  const prepared = preparedArtifact(spec, options.preparedArtifactArchives);
  try {
    return openCachedGroup(group, cache, checkDeadline);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
  const temporary = `.artifact-group-${randomUUID()}`;
  let allocated = false;
  let directory: HeldDirectory | undefined;
  let transferred = false;
  try {
    const sourceKey = `${spec.url ?? spec.bundleFile}\0${spec.sha256}`;
    const archive =
      prepared ??
      options.archives?.get(sourceKey) ??
      supplied ??
      (await download(spec, authority, controller.signal));
    const extracted = await extractArtifact(archive, spec, controller.signal, deadline);
    if (options.archives && !options.archives.has(sourceKey)) {
      options.archives.clear();
      options.archives.set(sourceKey, archive);
    }
    const tree = groupTree(group);
    function assign(target: readonly string[], bytes: Buffer): void {
      let parent = tree;
      for (const name of target.slice(0, -1)) parent = parent.directories.get(name)!;
      parent.files.get(target.at(-1)!)!.bytes = bytes;
    }
    assign(group.entryTarget, extracted.executable);
    for (const [id, bytes] of Object.entries(extracted.files)) assign(group.fileTargets[id]!, bytes);
    try {
      directory = cache.openChild(temporary, { create: true, exclusive: true });
      allocated = true;
    } catch (error) {
      // openChild closes any fd on failure, but mkdir may already have succeeded.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          cache.removeTree(temporary);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
            throw new AggregateError([error, cleanup], "artifact_cleanup_failed");
        }
      }
      throw error;
    }
    function writeTree(parent: HeldDirectory, node: GroupTree): void {
      for (const [name, file] of node.files) {
        checkDeadline();
        const writable = parent.createFile(name);
        try {
          let offset = 0;
          while (offset < file.bytes!.length) {
            checkDeadline();
            const count = writeSync(
              writable,
              file.bytes!,
              offset,
              Math.min(65536, file.bytes!.length - offset),
            );
            if (!count) throw new Error("artifact_short_write");
            offset += count;
          }
          fchmodSync(writable, 0o400);
          fsyncSync(writable);
        } finally {
          closeSync(writable);
        }
      }
      for (const [name, childTree] of node.directories) {
        checkDeadline();
        const child = parent.openChild(name, { create: true, exclusive: true });
        try {
          writeTree(child, childTree);
        } finally {
          child.close();
        }
      }
      chmodSync(parent.procPath, 0o500);
      parent.sync();
    }
    writeTree(directory, tree);
    verifyGroupTree(directory, tree, spec, checkDeadline);
    checkDeadline();
    try {
      cache.publish(temporary, managedToolGroupCacheKey(group), true);
      allocated = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // An atomic winner is usable only after the identical complete-tree verification.
      const winner = openCachedGroup(group, cache, checkDeadline);
      try {
        cache.removeTree(temporary);
        allocated = false;
        directory.close();
        directory = winner;
      } catch (cleanup) {
        return failManagedResources(undefined, [winner], cleanup);
      }
    }
    transferred = true;
    return directory;
  } catch (error) {
    const errors: unknown[] = [error];
    if (allocated) {
      try {
        cache.removeTree(temporary);
      } catch (cleanup) {
        // publish() can rename successfully and then fail its durability fence.
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") errors.push(cleanup);
      }
    }
    if (directory) {
      try {
        directory.close();
      } catch (cleanup) {
        errors.push(cleanup);
      }
      directory = undefined;
    }
    if (errors.length > 1) throw new AggregateError(errors, "artifact_cleanup_failed");
    throw error;
  } finally {
    clearTimeout(timer);
    if (!transferred) directory?.close();
  }
}

function managedSpecification(
  alias: string,
  specification: ManagedToolArtifact,
): { spec: ManagedToolArtifact; primary: MachineArtifact } {
  safeComponent(alias);
  const spec = ManagedToolArtifactSchema.parse(specification);
  const { fileGroups: _groups, ...primary } = spec;
  const targets = [
    [alias],
    ...Object.entries(primary.files ?? {}).map(([id, file]) => file.relativeTarget ?? [id]),
    ...(spec.fileGroups ?? []).map((group) => group.target),
  ].map((target) => target.join("/"));
  for (let i = 0; i < targets.length; i++)
    for (let j = 0; j < i; j++)
      if (
        targets[i] === targets[j] ||
        targets[i]!.startsWith(`${targets[j]}/`) ||
        targets[j]!.startsWith(`${targets[i]}/`)
      )
        throw new Error("artifact_group_target_collision");
  return { spec, primary };
}

function pinnedManagedTool(
  alias: string,
  spec: ManagedToolArtifact,
  primary: PinnedArtifact,
  groups: readonly HeldDirectory[],
): PinnedManagedTool {
  let closed = false;
  return {
    fd: primary.fd,
    archiveSha256: primary.archiveSha256,
    entrySha256: primary.entrySha256,
    bytes: primary.bytes,
    files: primary.files,
    binds: Object.freeze([
      Object.freeze({ fd: primary.fd, target: `/runtime/bin/${alias}`, writable: false }),
      ...groups.map((group, index) =>
        Object.freeze({
          fd: group.fd,
          target: `/runtime/bin/${spec.fileGroups![index]!.target.join("/")}`,
          writable: false,
        }),
      ),
    ]),
    close() {
      if (closed) return;
      closed = true;
      closeManagedResources(primary, groups);
    },
  };
}

function closeManagedResources(
  primary: PinnedArtifact | undefined,
  groups: readonly HeldDirectory[],
): void {
  const errors: unknown[] = [];
  for (const resource of [...groups, ...(primary ? [primary] : [])]) {
    try {
      resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "artifact_close_failed");
}

function failManagedResources(
  primary: PinnedArtifact | undefined,
  groups: readonly HeldDirectory[],
  failure: unknown,
): never {
  try {
    closeManagedResources(primary, groups);
  } catch (cleanup) {
    throw new AggregateError([failure, cleanup], "artifact_close_failed");
  }
  throw failure;
}

/** An alias is returned only when its primary, legacy companions and every group are held. */
export async function acquireManagedTool(
  alias: string,
  specification: ManagedToolArtifact,
  cache: HeldDirectory,
  authority: ArtifactAuthority,
  options: ManagedToolAcquisitionOptions = {},
): Promise<PinnedManagedTool> {
  const { spec, primary: primarySpec } = managedSpecification(alias, specification);
  let primary: PinnedArtifact | undefined;
  const groups: HeldDirectory[] = [];
  try {
    primary = await acquireArtifact(
      primarySpec,
      cache,
      authority,
      sourceDelivery(primarySpec, options),
      options.archives,
      options.decoded,
      options.preparedArtifactArchives,
    );
    for (const group of spec.fileGroups ?? [])
      groups.push(await acquireGroup(group, cache, authority, options));
    return pinnedManagedTool(alias, spec, primary, groups);
  } catch (error) {
    return failManagedResources(primary, groups, error);
  }
}

export function openCachedManagedTool(
  alias: string,
  specification: ManagedToolArtifact,
  cache: HeldDirectory,
): PinnedManagedTool {
  const { spec, primary: primarySpec } = managedSpecification(alias, specification);
  let primary: PinnedArtifact | undefined;
  const groups: HeldDirectory[] = [];
  try {
    primary = openCachedArtifact(primarySpec, cache);
    for (const group of spec.fileGroups ?? []) groups.push(openCachedGroup(group, cache));
    return pinnedManagedTool(alias, spec, primary, groups);
  } catch (error) {
    return failManagedResources(primary, groups, error);
  }
}
