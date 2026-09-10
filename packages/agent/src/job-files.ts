import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
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
      if (!stat.isFile() || stat.nlink !== 1 || fdMountId(fd) !== this.mountId)
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
      if (exclusive) {
        libc ??= dlopen("libc.so.6", FILE_SYMBOLS);
        const source = Buffer.from(`${temporary}\0`);
        const target = Buffer.from(`${destination}\0`);
        // A link/unlink substitute exposes nlink=2 and can leave that identity after a crash.
        if (libc.symbols.renameat2(this.fd, ptr(source), this.fd, ptr(target), 1) !== 0) {
          const address = libc.symbols.__errno_location();
          const code = address === null ? "UNKNOWN" : getSystemErrorName(-readNative.i32(address));
          throw Object.assign(new Error("exclusive_file_publication_failed"), { code });
        }
      } else {
        renameSync(`${this.procPath}/${temporary}`, `${this.procPath}/${destination}`);
      }
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
  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}
