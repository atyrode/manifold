import {
  constants,
  openSync,
  closeSync,
  chmodSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  fsyncSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dlopen, FFIType, ptr, read as readNative, type Library } from "bun:ffi";
import { connect, type Socket } from "node:net";
import { getSystemErrorName } from "node:util";

// Linux O_CLOEXEC and O_PATH are not exposed by every Node-compatible constants table.
export const CLOSE_ON_EXEC = 0x80000;
const DIRECTORY_FLAGS = 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC;

export function safeComponent(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\\0]/.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new Error("unsafe_file_component");
}
export function fdMountId(fd: number): number {
  const match = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
  if (!match) throw new Error("mount_identity_unavailable");
  return Number(match[1]);
}
/** The held descriptor's own mount is read-only by its per-mount flags, not its superblock's. */
export function fdMountReadOnly(fd: number): boolean {
  const mountId = String(fdMountId(fd));
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const fields = line.split(" ");
    if (fields[0] === mountId) return (fields[5] ?? "").split(",").includes("ro");
  }
  throw new Error("mount_identity_unavailable");
}
const FILE_SYMBOLS = {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  renameat2: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;
let libc: Library<typeof FILE_SYMBOLS> | undefined;
/** Lock remains owned by the open description until the caller closes it. */
export function lockExclusive(fd: number): void {
  libc ??= dlopen("libc.so.6", FILE_SYMBOLS);
  if (libc.symbols.flock(fd, 2 | 4) !== 0) throw new Error("job_owner_already_locked");
}
/** renameat2(RENAME_NOREPLACE) between held directories. */
function renameNoReplace(
  from: HeldDirectory,
  fromName: string,
  to: HeldDirectory,
  toName: string,
): void {
  libc ??= dlopen("libc.so.6", FILE_SYMBOLS);
  const source = Buffer.from(`${fromName}\0`);
  const target = Buffer.from(`${toName}\0`);
  // A link/unlink substitute exposes nlink=2 and can leave that identity after a crash.
  if (libc.symbols.renameat2(from.fd, ptr(source), to.fd, ptr(target), 1) !== 0) {
    const address = libc.symbols.__errno_location();
    const code = address === null ? "UNKNOWN" : getSystemErrorName(-readNative.i32(address));
    throw Object.assign(new Error("exclusive_file_publication_failed"), { code });
  }
}

/** Adopt an already-connected fd using Bun's extension to node:net. */
export function adoptPrivateSocket(fd: number): Socket {
  if (!Number.isSafeInteger(fd) || fd <= 0 || !fstatSync(fd).isSocket())
    throw new Error("invalid_private_socket");
  // Node's declarations omit this Bun overload; Socket({fd}) does not adopt in Bun.
  const connectFd = connect as unknown as (options: { fd: number }) => Socket;
  return connectFd({ fd });
}

export interface PrivateSocketPair {
  socket: Socket;
  childFd: number;
}
/** Both ends are private; the caller owns the socket and the close-on-exec child fd. */
export function privateSocketPair(): PrivateSocketPair {
  libc ??= dlopen("libc.so.6", FILE_SYMBOLS);
  const pair = new Int32Array(2);
  if (libc.symbols.socketpair(1, 1 | CLOSE_ON_EXEC, 0, ptr(pair)) !== 0)
    throw new Error("private_socketpair_unavailable");
  try {
    return { socket: adoptPrivateSocket(pair[0]!), childFd: pair[1]! };
  } catch (error) {
    closeSync(pair[0]!);
    closeSync(pair[1]!);
    throw error;
  }
}

/** Anonymous sealed bytes, returned read-only at offset zero; caller owns the descriptor. */
export function privateByteFile(bytes: Uint8Array): number {
  libc ??= dlopen("libc.so.6", FILE_SYMBOLS);
  const name = Buffer.from("manifold-job-policy\0");
  const fd = libc.symbols.memfd_create(ptr(name), 1 | 2);
  if (fd < 0) throw new Error("private_policy_file_unavailable");
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written === 0) throw new Error("short_policy_write");
      offset += written;
    }
    fchmodSync(fd, 0o400);
    // F_SEAL_SEAL | SHRINK | GROW | WRITE: even reopening via proc cannot mutate the bytes.
    if (libc.symbols.fcntl(fd, 1033, 15) !== 0) throw new Error("private_file_sealing_failed");
    return openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | CLOSE_ON_EXEC);
  } finally {
    closeSync(fd);
  }
}

export function isSealedByteFile(fd: number): boolean {
  libc ??= dlopen("libc.so.6", FILE_SYMBOLS);
  const seals = libc.symbols.fcntl(fd, 1034, 0);
  return seals >= 0 && (seals & 15) === 15;
}

/** Identity ancestry of a held directory, never a checked-and-reopened pathname. */
export function directoryAncestry(directoryFd: number): string[] {
  const identities: string[] = [];
  let current = openSync(`/proc/self/fd/${directoryFd}/.`, DIRECTORY_FLAGS);
  try {
    for (let depth = 0; depth < 256; depth++) {
      const stat = fstatSync(current, { bigint: true });
      identities.push(`${stat.dev}:${stat.ino}`);
      const parent = openSync(`/proc/self/fd/${current}/..`, DIRECTORY_FLAGS);
      const parentStat = fstatSync(parent, { bigint: true });
      if (parentStat.dev === stat.dev && parentStat.ino === stat.ino) {
        closeSync(parent);
        return identities;
      }
      closeSync(current);
      current = parent;
    }
    throw new Error("directory_ancestry_limit");
  } finally {
    closeSync(current);
  }
}

function heldIdentity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

/** Allocation ownership survives descriptor or mount-identity acquisition failure. */
export interface DirectoryAllocation {
  acquire(): HeldDirectory;
}

/** Owned Linux directory descriptor. All descendant opens use a single checked component. */
export class HeldDirectory {
  readonly mountId: number;
  private closed = false;
  private constructor(readonly fd: number) {
    this.mountId = fdMountId(fd);
  }
  get procPath(): string {
    if (this.closed) throw new Error("directory_closed");
    return `/proc/self/fd/${this.fd}`;
  }
  static openAbsolute(path: string, options: { private?: boolean } = {}): HeldDirectory {
    if (process.platform !== "linux" || !path.startsWith("/") || path.includes("\0"))
      throw new Error("unsupported_directory_anchor");
    const parts = path.split("/").filter(Boolean);
    let fd = openSync("/", DIRECTORY_FLAGS);
    try {
      for (const part of parts) {
        safeComponent(part);
        const next = openSync(`/proc/self/fd/${fd}/${part}`, DIRECTORY_FLAGS);
        closeSync(fd);
        fd = next;
      }
      const stat = fstatSync(fd);
      if (options.private && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        throw new Error("directory_not_private");
      return new HeldDirectory(fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  stat(): Stats {
    return fstatSync(this.fd);
  }
  /** A separately owned handle on this same directory: closing either leaves the other open. */
  reopen(): HeldDirectory {
    const fd = openSync(`${this.procPath}/.`, DIRECTORY_FLAGS);
    try {
      const copy = new HeldDirectory(fd);
      if (copy.mountId !== this.mountId) throw new Error("mount_escape");
      return copy;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  /** Exclusive mkdir with retained identity; callers keep this obligation until reclamation. */
  allocateChild(name: string, mode = 0o700): DirectoryAllocation {
    safeComponent(name);
    const path = `${this.procPath}/${name}`;
    let identity: string | undefined;
    let identityFailure: unknown;
    let pendingFd: number | undefined;
    let acquired: HeldDirectory | undefined;
    const allocation: DirectoryAllocation = {
      acquire: () => {
        if (acquired) return acquired;
        // An identity missed at allocation cannot later be inferred from the same pathname.
        if (identity === undefined) throw identityFailure;
        pendingFd ??= openSync(path, DIRECTORY_FLAGS);
        if (heldIdentity(pendingFd) !== identity) {
          closeSync(pendingFd);
          pendingFd = undefined;
          throw new Error("directory_tree_changed");
        }
        // Keep the raw descriptor if the mount probe fails: it still pins the allocated inode.
        const child = new HeldDirectory(pendingFd);
        if (child.mountId !== this.mountId) {
          closeSync(pendingFd);
          pendingFd = undefined;
          throw new Error("mount_escape");
        }
        acquired = child;
        pendingFd = undefined;
        return child;
      },
    };
    mkdirSync(path, { mode });
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory()) throw new Error("directory_tree_changed");
      identity = `${stat.dev}:${stat.ino}`;
    } catch (error) {
      identityFailure = error;
    }
    return allocation;
  }
  openChild(
    name: string,
    options: { create?: boolean; exclusive?: boolean; mode?: number } = {},
  ): HeldDirectory {
    safeComponent(name);
    if (options.create) {
      try {
        mkdirSync(`${this.procPath}/${name}`, { mode: options.mode ?? 0o700 });
      } catch (error) {
        if (options.exclusive || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const fd = openSync(`${this.procPath}/${name}`, DIRECTORY_FLAGS);
    try {
      const child = new HeldDirectory(fd);
      if (child.mountId !== this.mountId) throw new Error("mount_escape");
      return child;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  openFile(name: string, flags = constants.O_RDONLY, mode = 0o600): number {
    return this.openRegularFile(name, flags, mode, true);
  }
  // Runtime resources may share storage, but their retained handles never grant writes.
  openRuntimeFile(name: string): number {
    return this.openRegularFile(name, constants.O_RDONLY, 0o600, false);
  }
  private openRegularFile(name: string, flags: number, mode: number, singleLink: boolean): number {
    safeComponent(name);
    // Never truncate before checking kind/link identity. Callers truncate the returned fd if needed.
    if (flags & constants.O_TRUNC) throw new Error("unsafe_open_truncation");
    const fd = openSync(
      `${this.procPath}/${name}`,
      flags | constants.O_NOFOLLOW | CLOSE_ON_EXEC | constants.O_NONBLOCK,
      mode,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (singleLink && stat.nlink !== 1) || fdMountId(fd) !== this.mountId)
        throw new Error("unsafe_file_identity");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  createFile(name: string, mode = 0o600): number {
    return this.openFile(name, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, mode);
  }
  names(): string[] {
    return readdirSync(this.procPath);
  }
  readDir(): string[] {
    return this.names();
  }
  /** Byte-exact directory names; callers decide whether non-directory entries are removable. */
  directoryNames(): Buffer[] {
    return readdirSync(this.procPath, { encoding: "buffer" }).filter((name) =>
      lstatSync(this.entryPath(name)).isDirectory(),
    );
  }
  /** Open a byte-named directory without changing its permissions or crossing this mount. */
  openDirectoryEntry(name: Buffer): HeldDirectory {
    this.checkedEntry(name);
    return this.openEntryDirectory(name, false);
  }
  /** Recheck the name against the retained directory, including its mount identity. */
  assertDirectoryEntry(name: Buffer, directory: HeldDirectory): void {
    this.checkedEntry(name);
    if (directory.mountId !== this.mountId) throw new Error("mount_escape");
    const named = this.openDirectoryEntry(name);
    try {
      if (heldIdentity(named.fd) !== heldIdentity(directory.fd))
        throw new Error("directory_tree_changed");
    } finally {
      named.close();
    }
  }
  /** Remove only this still-named held directory. Never unlink files or recurse. */
  removeDirectoryEntry(name: Buffer, directory: HeldDirectory): void {
    this.assertDirectoryEntry(name, directory);
    rmdirSync(this.entryPath(name));
  }
  private checkedEntry(name: Buffer): void {
    if (
      name.length === 0 ||
      name.length > 255 ||
      (name.length === 1 && name[0] === 0x2e) ||
      (name.length === 2 && name[0] === 0x2e && name[1] === 0x2e) ||
      name.includes(0) ||
      name.includes(0x2f)
    )
      throw new Error("unsafe_file_component");
  }
  unlink(name: string): void {
    safeComponent(name);
    unlinkSync(`${this.procPath}/${name}`);
  }
  sync(): void {
    const fd = openSync(
      `${this.procPath}/.`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  /** Only private, trusted-writer directories may publish or replace names. */
  publish(temporary: string, destination: string, exclusive = false): void {
    safeComponent(temporary);
    safeComponent(destination);
    const stat = this.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("directory_not_private");
    // Searchable handles retain identity without directory-listing authority.
    // Publication additionally needs a readable descriptor for the durability fence.
    const syncFd = openSync(
      `${this.procPath}/.`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC,
    );
    try {
      if (exclusive) renameNoReplace(this, temporary, this, destination);
      else renameSync(`${this.procPath}/${temporary}`, `${this.procPath}/${destination}`);
      fsyncSync(syncFd);
    } finally {
      closeSync(syncFd);
    }
  }
  atomicWrite(name: string, data: Uint8Array | string, mode = 0o600, exclusive = false): void {
    safeComponent(name);
    const temporary = `.stage-${randomUUID()}`;
    const fd = this.createFile(temporary, mode);
    try {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error("short_file_write");
        offset += written;
      }
      fsyncSync(fd);
      this.publish(temporary, name, exclusive);
    } catch (error) {
      try {
        this.unlink(temporary);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AggregateError([error, cleanup], "atomic_write_cleanup_failed");
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  /**
   * Opens and validates the read-only staging inode before publishing it. `handoff` takes
   * ownership synchronously at publication and must not throw; no destination reopen occurs.
   * A later durability failure is thrown with the published descriptor already handed off.
   */
  atomicWriteHeld(
    name: string,
    data: Uint8Array,
    validate: (fd: number) => void,
    handoff: (fd: number) => void,
    mode = 0o600,
    exclusive = false,
  ): void {
    safeComponent(name);
    const stat = this.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("directory_not_private");
    const syncFd = openSync(
      `${this.procPath}/.`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC,
    );
    const temporary = `.stage-${randomUUID()}`;
    let fd: number | undefined;
    let readFd: number | undefined;
    try {
      fd = this.createFile(temporary, mode);
      const bytes = data;
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error("short_file_write");
        offset += written;
      }
      fsyncSync(fd);
      readFd = this.openFile(temporary);
      const writer = fstatSync(fd, { bigint: true });
      const reader = fstatSync(readFd, { bigint: true });
      if (writer.dev !== reader.dev || writer.ino !== reader.ino)
        throw new Error("staged_file_identity_changed");
      validate(readFd);
      if (exclusive) renameNoReplace(this, temporary, this, name);
      else renameSync(`${this.procPath}/${temporary}`, `${this.procPath}/${name}`);
      const publishedFd = readFd;
      readFd = undefined;
      handoff(publishedFd);
      fsyncSync(syncFd);
    } catch (error) {
      try {
        this.unlink(temporary);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AggregateError([error, cleanup], "atomic_write_cleanup_failed");
      }
      throw error;
    } finally {
      if (readFd !== undefined) closeSync(readFd);
      if (fd !== undefined) closeSync(fd);
      closeSync(syncFd);
    }
  }
  /** Moves one entry into another held directory on this mount; never replaces a name there. */
  moveInto(name: string, destination: HeldDirectory): void {
    safeComponent(name);
    if (destination.mountId !== this.mountId) throw new Error("mount_escape");
    renameNoReplace(this, name, destination, name);
  }
  /**
   * Removes the private tree at `name`, which a workload proven empty may have shaped at will:
   * any depth, width, mode or byte name. Every step acts on a held descriptor of the directory
   * being emptied, never follows a link or leaves this mount, and holds one descendant
   * descriptor at a time whatever the depth. The owner restores only its own search and write
   * bits on a directory the kernel lets it change; a tree that changes underneath refuses
   * rather than redirecting a removal.
   */
  removeTree(name: string): void {
    safeComponent(name);
    if (!lstatSync(`${this.procPath}/${name}`).isDirectory()) {
      this.unlink(name);
      return;
    }
    // Per level: its name one level up, that directory's identity, and the subdirectories still
    // to remove. Only directories wait; every other entry is unlinked as the level is entered.
    const levels: Array<{ name: Buffer; parent: string; pending: Buffer[] }> = [];
    let current = this.reopen();
    let next: Buffer | undefined = Buffer.from(name);
    try {
      for (;;) {
        if (next !== undefined) {
          const parent = heldIdentity(current.fd);
          const child = current.openEntryDirectory(next);
          current.close();
          current = child;
          const pending: Buffer[] = [];
          for (const entry of readdirSync(current.procPath, { encoding: "buffer" })) {
            const path = current.entryPath(entry);
            if (lstatSync(path).isDirectory()) pending.push(entry);
            else unlinkSync(path);
          }
          levels.push({ name: next, parent, pending });
        }
        const level = levels.at(-1)!;
        next = level.pending.pop();
        if (next !== undefined) continue;
        // Everything below is gone: climb to the directory this level was entered from and
        // remove it there by the name it was entered through, if that still names it.
        const emptied = fstatSync(current.fd, { bigint: true });
        const fd = openSync(`${current.procPath}/..`, DIRECTORY_FLAGS);
        let above: HeldDirectory;
        try {
          above = new HeldDirectory(fd);
        } catch (error) {
          closeSync(fd);
          throw error;
        }
        current.close();
        current = above;
        const named = lstatSync(current.entryPath(level.name), { bigint: true });
        if (
          heldIdentity(current.fd) !== level.parent ||
          named.dev !== emptied.dev ||
          named.ino !== emptied.ino
        )
          throw new Error("directory_tree_changed");
        rmdirSync(current.entryPath(level.name));
        levels.pop();
        if (levels.length === 0) return;
      }
    } finally {
      current.close();
    }
  }
  private entryPath(name: Buffer): Buffer {
    return Buffer.concat([Buffer.from(`${this.procPath}/`), name]);
  }
  /** A byte-named subdirectory entry, never through a link or onto another mount. */
  private openEntryDirectory(name: Buffer, restorePermissions = true): HeldDirectory {
    const path = this.entryPath(name);
    const before = lstatSync(path, { bigint: true });
    const fd = openSync(path, DIRECTORY_FLAGS);
    try {
      const child = new HeldDirectory(fd);
      const held = fstatSync(fd, { bigint: true });
      if (child.mountId !== this.mountId) throw new Error("mount_escape");
      if (held.dev !== before.dev || held.ino !== before.ino)
        throw new Error("directory_tree_changed");
      // A workload may clear its own directory's bits; only their owner may restore them.
      if (restorePermissions && (Number(held.mode) & 0o700) !== 0o700)
        chmodSync(child.procPath, 0o700);
      return child;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}
