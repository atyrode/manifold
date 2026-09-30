import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType, ptr, read as readNative } from "bun:ffi";
import { NATIVE_TRANSFER_MAX_FILE_BYTES, NATIVE_TRANSFER_MAX_CHUNK_BYTES } from "@manifold/protocol";
import { CLOSE_ON_EXEC, createPrivateByteFile, isSealedByteFile } from "./job-files.ts";

const HELPER_FLAG = "--native-transfer-snapshot";
const HELPER_MS = 5000;
const REFUSALS: Record<number, string> = {
  2: "native_snapshot_unsupported",
  3: "native_source_writer_active",
  4: "native_source_changed",
  5: "native_snapshot_failed",
};

/** A disposable process owns the lease; inherited fds are its only filesystem authority. */
export async function stableNativeSnapshot(sourceFd: number, reservedBytes: number, signal: AbortSignal): Promise<number> {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw new Error("native_snapshot_unsupported");
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > NATIVE_TRANSFER_MAX_FILE_BYTES)
    throw new Error("native_transfer_file_limit");
  signal.throwIfAborted();
  const output = createPrivateByteFile();
  // A distinct open description: killing the helper must release its lease even while the
  // owner still holds the original source. The child's copy alone owns this description.
  let source = -1;
  let child: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const kill = () => child?.kill("SIGKILL");
  try {
    source = openSync(`/proc/self/fd/${sourceFd}`, constants.O_RDONLY | constants.O_NONBLOCK | CLOSE_ON_EXEC);
    const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
    child = Bun.spawn(
      entry.startsWith("/$bunfs/")
        ? [process.execPath, HELPER_FLAG, String(reservedBytes)]
        : [process.execPath, entry, HELPER_FLAG, String(reservedBytes)],
      { cwd: "/", env: {}, stdio: ["ignore", "ignore", "ignore", source, output] },
    );
    closeSync(source);
    source = -1;
    timer = setTimeout(() => { timedOut = true; kill(); }, HELPER_MS);
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    const code = await child.exited;
    if (signal.aborted) throw new Error("native_transfer_cancelled");
    if (timedOut) throw new Error("native_snapshot_timeout");
    if (code !== 0) throw new Error(REFUSALS[code] ?? "native_snapshot_failed");
    if (!isSealedByteFile(output)) throw new Error("native_snapshot_unsealed");
    if (fstatSync(output).size !== reservedBytes) throw new Error("native_source_changed");
    return output;
  } catch (error) {
    closeSync(output);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    if (source >= 0) closeSync(source);
  }
}

/** Called only by the fixed executable switch, before agent/owner startup or credential loading. */
export function runNativeTransferSnapshotHelper(reservation: string | undefined): never {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) process.exit(2);
  const reservedBytes = Number(reservation);
  if (String(reservedBytes) !== reservation || !Number.isSafeInteger(reservedBytes) ||
      reservedBytes < 0 || reservedBytes > NATIVE_TRANSFER_MAX_FILE_BYTES) process.exit(4);
  const libc = dlopen("libc.so.6", {
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    signal: { args: [FFIType.i32, FFIType.u64], returns: FFIType.ptr },
    getppid: { args: [], returns: FFIType.i32 },
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64_fast },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  let lease = false;
  let result = 5;
  try {
    const parent = libc.symbols.getppid();
    if (parent === 1 || libc.symbols.prctl(1, 9, null, 0, 0) !== 0 || libc.symbols.getppid() !== parent)
      process.exit(2);
    // A break request is detected with F_GETLEASE; SIGIO must not escape into the owner.
    // Even a zero kernel lease-break timeout is safe: losing the lease invalidates the copy.
    libc.symbols.signal(29, 1);
    const before = fstatSync(3, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(reservedBytes))
      process.exit(4);
    if (!fstatSync(4).isFile() || fstatSync(4).size !== 0 || libc.symbols.fcntl(4, 1034, 0) !== 0)
      process.exit(2);
    // Once initialized, no pathname, socket, exec or process-creation syscall is admitted.
    // TSYNC covers Bun's existing runtime threads too; failure is an honest unsupported result.
    const x64 = process.arch === "x64";
    // libc may implement fstat with pathname-taking newfstatat. Use the actual descriptor
    // syscall after confinement instead. Linux's x86_64 and asm-generic (aarch64) stat ABIs
    // share size/time offsets; only nlink differs. No pathname syscall is made permissible.
    const stat = Buffer.alloc(144);
    const descriptorStat = () => {
      if (Number(libc.symbols.syscall(x64 ? 5 : 80, 3, ptr(stat), 0)) !== 0)
        throw new Error("snapshot_stat_failed");
      return {
        size: stat.readBigInt64LE(48),
        nlink: x64 ? stat.readBigUInt64LE(16) : BigInt(stat.readUInt32LE(20)),
        mtimeNs: stat.readBigInt64LE(88) * 1_000_000_000n + stat.readBigUInt64LE(96),
        ctimeNs: stat.readBigInt64LE(104) * 1_000_000_000n + stat.readBigUInt64LE(112),
      };
    };
    const allowed = x64
      ? [0, 1, 3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 24, 25, 28, 35, 39, 60, 72, 74, 75, 77, 91, 96, 102, 104, 107, 108, 110, 131, 158, 186, 202, 204, 218, 228, 230, 231, 232, 233, 234, 273, 281, 290, 291, 292, 302, 318, 334, 436, 441, 449]
      : [23, 25, 57, 62, 63, 64, 67, 68, 80, 82, 83, 93, 94, 96, 98, 99, 101, 113, 115, 124, 129, 130, 131, 132, 134, 135, 139, 169, 172, 173, 174, 175, 176, 177, 178, 214, 215, 216, 222, 226, 233, 261, 278, 293, 436, 441, 449];
    const instructions: number[][] = [
      [0x20, 0, 0, 4], [0x15, 1, 0, x64 ? 0xc000003e : 0xc00000b7],
      [0x06, 0, 0, 0x80000000], [0x20, 0, 0, 0],
    ];
    for (const nr of allowed) instructions.push([0x15, 0, 1, nr], [0x06, 0, 0, 0x7fff0000]);
    instructions.push([0x06, 0, 0, 0x00050001]);
    const filter = Buffer.alloc(instructions.length * 8);
    instructions.forEach(([code, jt, jf, k], index) => {
      filter.writeUInt16LE(code!, index * 8);
      filter[index * 8 + 2] = jt!;
      filter[index * 8 + 3] = jf!;
      filter.writeUInt32LE(k!, index * 8 + 4);
    });
    const program = Buffer.alloc(16);
    program.writeUInt16LE(instructions.length);
    program.writeBigUInt64LE(BigInt(ptr(filter)), 8);
    if (libc.symbols.prctl(38, 1, null, 0, 0) !== 0 ||
        Number(libc.symbols.syscall(x64 ? 317 : 277, 1, 1, ptr(program))) !== 0)
      process.exit(2);
    // F_SETLEASE(F_RDLCK) refuses any existing writable fd or writable mapping.
    if (libc.symbols.fcntl(3, 1024, 0) !== 0) {
      const address = libc.symbols.__errno_location();
      process.exit(address !== null && readNative.i32(address) === 11 ? 3 : 2);
    }
    lease = true;
    const start = descriptorStat();
    if (start.size !== BigInt(reservedBytes) || start.size !== before.size ||
        start.ctimeNs !== before.ctimeNs || start.mtimeNs !== before.mtimeNs)
      process.exit(4);
    const buffer = Buffer.allocUnsafe(Math.min(NATIVE_TRANSFER_MAX_CHUNK_BYTES, reservedBytes));
    let offset = 0;
    while (offset < reservedBytes) {
      const length = readSync(3, buffer, 0, Math.min(buffer.length, reservedBytes - offset), offset);
      if (!length) throw new Error("short_snapshot_read");
      let written = 0;
      while (written < length) {
        const n = writeSync(4, buffer, written, length - written, offset + written);
        if (!n) throw new Error("short_snapshot_write");
        written += n;
      }
      offset += length;
    }
    const end = descriptorStat();
    if (libc.symbols.fcntl(3, 1025, 0) !== 0 || end.size !== start.size ||
        end.ctimeNs !== start.ctimeNs || end.mtimeNs !== start.mtimeNs || end.nlink !== 1n) {
      result = 4;
    } else if (libc.symbols.fcntl(4, 1033, 15) === 0) {
      result = 0;
    }
  } catch {
    result = 5;
  } finally {
    if (lease) libc.symbols.fcntl(3, 1024, 2);
    closeSync(3);
    closeSync(4);
  }
  process.exit(result);
}
