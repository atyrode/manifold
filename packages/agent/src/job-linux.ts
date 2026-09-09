import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  statfsSync,
  openSync,
  opendirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { MachineLocationSchema } from "@manifold/protocol";
import { ownsWorkloadLoopbackListener } from "./job-listener-proof.ts";
import type { HeldDirectory } from "./job-files.ts";
import {
  fdMountId,
  safeComponent,
  privateSocketPair,
  privateByteFile,
  isSealedByteFile,
  type PrivateSocketPair,
} from "./job-files.ts";

/** All paths/argv below are resolved by the trusted manifest admission layer, never RPC input. */
export interface LinuxJobBind {
  fd: number;
  target: string;
  writable: boolean;
}
export interface LinuxJobLimits {
  timeoutMs: number;
  memoryBytes: number;
  processes: number;
  outputBytes: number;
}
export interface LinuxJobOutput {
  sequence: number;
  channel: "stdout" | "stderr";
  bytes: Uint8Array;
}
/** Private PTY handoff. The runtime installs its meter before any process can emit bytes. */
export interface LinuxJobTerminal {
  pty: Bun.Terminal;
  onOutput(bytes: Uint8Array): void;
  setOutputHandler(handler: (bytes: Uint8Array) => void): void;
}
export interface LinuxJobSpec {
  /** Pinned, trusted bubblewrap supporting --bind-fd and --ro-bind-fd. */
  bubblewrapFd: number;
  artifactFd: number;
  /** Reviewed manifest runtime alias, never a caller path. */
  executableRuntimeTool?: string;
  /** Sealed anonymous readonly files, separate from runtime closures and output writers. */
  inputFiles?: readonly LinuxJobBind[];
  argv: readonly string[];
  runtime: readonly LinuxJobBind[];
  locations: readonly LinuxJobBind[];
  /** Exact directory mount selected by the reviewed operation, not a caller path. */
  workingDirectory?: string;
  outputs: readonly LinuxJobBind[];
  /** Dedicated, empty cgroup-v2 delegation with memory and pids enabled. */
  delegatedCgroup: HeldDirectory;
  limits: LinuxJobLimits;
  network: "none" | "host";
  bidirectional: boolean;
  /** Exposes only /sys/fs/cgroup/workloads; the enforcing ancestor is never mounted. */
  nestedCgroup?: boolean;
  /** A private, already-authorized connected socket; inherited as fd 3, no other authority. */
  contextFd?: number;
  /** Owned by the native terminal host; never supplied by a workload or wire caller. */
  terminal?: LinuxJobTerminal;
  /** Must consume synchronously. Throwing terminates the workload, rather than losing bytes. */
  onOutput?: (output: LinuxJobOutput) => void;
}
export interface LinuxJobResult {
  exitCode: number | null;
  signal: string | null;
  reason: "exited" | "cancelled" | "timeout" | "output-limit" | "output-consumer" | "input-error";
  startedAt: number;
  finishedAt: number;
  /** Resolves only after cgroup.events reports populated=0. Safe point for output sealing. */
  empty: true;
  boundary: "linux-bubblewrap-cgroup-v2";
  usage: {
    wallMs: number;
    cpuUsec: number;
    memoryPeakBytes: number;
    processesPeak: number;
    outputBytes: number;
    oomKills: number;
  };
}
export interface LinuxJobHandle {
  result: Promise<LinuxJobResult>;
  /** Borrowed owner-only delegation for separately admitted child jobs. Never mounted. */
  childDelegation: HeldDirectory;
  /** Kernel-backed live workload ownership, never a connectivity probe. */
  ownsLoopbackListener(port: number): boolean;
  /** Close retained group handles after result and child/output sealing; idempotent. */
  release(): void;
  input(bytes: Uint8Array): Promise<void>;
  endInput(): void;
  cancel(): Promise<LinuxJobResult>;
}
export class LinuxJobRefusal extends Error {
  constructor(
    readonly code: string,
    message = code,
    /** Positive startup cleanup observation, never inferred merely from a rejected promise. */
    readonly workloadEmpty = false,
    /** Retains startup containment when emptiness is unknown; resolves only after empty proof. */
    readonly cleanup?: () => Promise<void>,
  ) {
    super(message);
    this.name = "LinuxJobRefusal";
  }
}
function refuse(code: string): never {
  throw new LinuxJobRefusal(code);
}
/** Called only before spawn or after positively observing an empty execution cgroup. */
function observedStartRefusal(error: unknown): LinuxJobRefusal {
  const code = error instanceof LinuxJobRefusal ? error.code : "sandbox-start-failed";
  return new LinuxJobRefusal(code, code, true);
}
const CGROUP2_SUPER_MAGIC = 0x63677270;
const FRAME_BYTES = 64 * 1024;

function readControl(directory: HeldDirectory, name: string): string {
  const fd = directory.openFile(name);
  try {
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}
function writeControl(directory: HeldDirectory, name: string, value: string): void {
  const fd = directory.openFile(name, constants.O_WRONLY);
  try {
    if (writeSync(fd, value) !== Buffer.byteLength(value)) refuse("cgroup-short-write");
  } finally {
    closeSync(fd);
  }
}
function counter(text: string, key: string): number {
  const entry = text.split("\n").find((line) => line.startsWith(`${key} `));
  const value = entry?.slice(key.length + 1);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return refuse("cgroup-invalid-counter");
  return Number(value);
}
function executable(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o6022) !== 0)
    refuse("untrusted-executable");
}
function destination(target: string): void {
  if (
    !target.startsWith("/") ||
    target === "/" ||
    target.length > 4096 ||
    target.includes("\0") ||
    target
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  )
    refuse("invalid-mount-target");
  for (const reserved of ["/proc", "/dev", "/sys", "/run", "/tmp", "/job"]) {
    if (target === reserved || target.startsWith(`${reserved}/`)) refuse("reserved-mount-target");
  }
}

// Bubblewrap binds directories recursively. Inspect the actual held tree, not a
// pathname snapshot, before permitting that recursive authority into the sandbox.
// O_PATH opens cannot trigger a FIFO/device and O_NOFOLLOW retains symlinks as links.
function inspectMountDirectory(
  fd: number,
  mountId: number,
  depth: number,
  budget: { entries: number },
): void {
  if (depth > 64) refuse("mount-tree-depth-limit");
  const directory = opendirSync(`/proc/self/fd/${fd}`);
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++budget.entries > 100_000) refuse("mount-tree-entry-limit");
      safeComponent(entry.name);
      const child = openSync(
        `/proc/self/fd/${fd}/${entry.name}`,
        0x200000 | 0x80000 | constants.O_NOFOLLOW,
      );
      try {
        if (fdMountId(child) !== mountId) refuse("mount-tree-crossing");
        const stat = fstatSync(child);
        if (stat.isDirectory()) inspectMountDirectory(child, mountId, depth + 1, budget);
        else if (!stat.isFile() && !stat.isSymbolicLink()) refuse("unsafe-mount-entry");
      } finally {
        closeSync(child);
      }
    }
  } finally {
    directory.closeSync();
  }
}

/** Exporting FDs invalidates output-writer closure, even across disjoint declared mounts.
 * The byte-only job context uses read/write, not ancillary SCM_RIGHTS messages.
 * sendmsg/sendmmsg and io_uring are deliberately unavailable, including for host networking. */
function jobSeccompFilter(): Buffer {
  const arch = process.arch === "x64" ? 0xc000003e : process.arch === "arm64" ? 0xc00000b7 : null;
  if (arch === null) refuse("unsupported-seccomp-architecture");
  const denied = process.arch === "x64" ? [46, 307, 425, 426, 427] : [211, 269, 425, 426, 427];
  const instructions = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, arch],
    [0x06, 0, 0, 0x80000000], // KILL_PROCESS on any alternate ABI (including int 0x80)
    [0x20, 0, 0, 0], // seccomp_data.nr
  ];
  if (process.arch === "x64") instructions.push([0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001]); // reject x32
  for (const syscall of denied) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]); // ERRNO(EPERM)
  instructions.push([0x06, 0, 0, 0x7fff0000]); // ALLOW
  const bytes = Buffer.alloc(instructions.length * 8);
  for (const [index, instruction] of instructions.entries()) {
    bytes.writeUInt16LE(instruction[0]!, index * 8);
    bytes[index * 8 + 2] = instruction[1]!;
    bytes[index * 8 + 3] = instruction[2]!;
    bytes.writeUInt32LE(instruction[3]!, index * 8 + 4);
  }
  return bytes;
}

/** Admission must check this before preparing any private job descriptors. */
export function preflightLinuxJobRuntime(): void {
  if (process.platform !== "linux") refuse("linux-required");
  // Older Bun can close borrowed extra stdio FDs, corrupting the owner's authority.
  // Check only this boundary: ordinary terminal transport does not borrow job FDs.
  if (typeof Bun === "undefined" || !Bun.semver.satisfies(Bun.version, ">=1.4.2"))
    throw new LinuxJobRefusal(
      "bun-job-fd-ownership-unsupported",
      "Governed Linux jobs require Bun >=1.4.2 to preserve borrowed stdio descriptors; upgrade Bun before retrying.",
    );
  if (process.arch !== "x64" && process.arch !== "arm64")
    refuse("unsupported-seccomp-architecture");
}

/** Preflight performs no process creation. Returns capacity reserved for named output storage.
 * Namespace setup itself is fail-closed in bubblewrap. */
export function preflightLinuxJob(spec: LinuxJobSpec): number {
  preflightLinuxJobRuntime();
  if (
    ![
      spec.limits.memoryBytes,
      spec.limits.processes,
      spec.limits.outputBytes,
      spec.limits.timeoutMs,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    spec.limits.processes >= Number.MAX_SAFE_INTEGER ||
    spec.limits.timeoutMs > 2_147_483_647
  )
    refuse("invalid-limits");
  if (spec.network !== "none" && spec.network !== "host") refuse("unsupported-network");
  if (
    spec.argv.length > 1024 ||
    spec.argv.some(
      (arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 65536,
    )
  )
    refuse("invalid-fixed-argv");
  const inputFiles = spec.inputFiles ?? [];
  const binds = [...spec.runtime, ...spec.locations, ...spec.outputs, ...inputFiles];
  if (binds.length > 256) refuse("too-many-mounts");
  for (const bind of binds) destination(bind.target);
  if (
    spec.workingDirectory !== undefined &&
    !spec.locations.some(
      (bind) => bind.target === spec.workingDirectory && fstatSync(bind.fd).isDirectory(),
    )
  )
    refuse("invalid-working-directory");
  for (let i = 0; i < binds.length; i++) {
    const a = binds[i]!;
    if (
      binds
        .slice(i + 1)
        .some(
          (b) =>
            a.target === b.target ||
            a.target.startsWith(`${b.target}/`) ||
            b.target.startsWith(`${a.target}/`),
        )
    )
      refuse("overlapping-mounts");
  }
  if (spec.runtime.some((bind) => bind.writable)) refuse("writable-runtime");
  if (
    [...spec.runtime, ...spec.locations, ...spec.outputs].some(
      (bind) => bind.target === "/inputs" || bind.target.startsWith("/inputs/"),
    )
  )
    refuse("reserved-input-target");
  let inputBytes = 0;
  for (const bind of inputFiles) {
    const namedInput = /^\/inputs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bind.target);
    const privateHomeInput = MachineLocationSchema.shape.guestPath.safeParse(bind.target).success;
    if (
      bind.writable ||
      (!namedInput && !privateHomeInput) ||
      !fstatSync(bind.fd).isFile() ||
      !isSealedByteFile(bind.fd)
    )
      refuse("unsafe-input-file");
    inputBytes += fstatSync(bind.fd).size;
  }
  if (inputBytes > 65536) refuse("input-file-byte-limit");
  if (spec.executableRuntimeTool !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.executableRuntimeTool))
      refuse("invalid-runtime-executable");
    const matches = spec.runtime.filter(
      (bind) => bind.target === `/runtime/bin/${spec.executableRuntimeTool}`,
    );
    if (matches.length !== 1 || matches[0]!.writable) refuse("runtime-executable-unavailable");
    executable(matches[0]!.fd);
  }
  executable(spec.bubblewrapFd);
  executable(spec.artifactFd);
  const mountBudget = { entries: 0 };
  for (const bind of binds) {
    const stat = fstatSync(bind.fd);
    if (!stat.isFile() && !stat.isDirectory()) refuse("unsafe-mount-source");
    if (stat.isDirectory()) inspectMountDirectory(bind.fd, fdMountId(bind.fd), 0, mountBudget);
  }
  // A writable host directory is NOT a byte quota. Only an already-provisioned bounded
  // tmpfs is accepted: ENOSPC is enforced synchronously by the kernel during writes,
  // including through another authorized alias. Administrators/unconfined same-UID
  // processes that can remount it are outside the runner's threat boundary.
  const outputDevices = new Set<bigint>();
  let outputCapacity = 0n;
  let outputInodes = 0n;
  for (const output of spec.outputs) {
    const stat = fstatSync(output.fd, { bigint: true });
    const fs = statfsSync(`/proc/self/fd/${output.fd}`, { bigint: true });
    if (!output.writable || !stat.isDirectory() || fs.type !== 0x01021994n)
      refuse("bounded-output-storage-required");
    if (outputDevices.has(stat.dev)) continue;
    outputDevices.add(stat.dev);
    if (fs.blocks <= 0n || fs.bsize <= 0n || fs.files <= 0n)
      refuse("bounded-output-storage-required");
    outputCapacity += fs.blocks * fs.bsize;
    outputInodes += fs.files;
    if (outputCapacity > BigInt(spec.limits.outputBytes) || outputInodes > 10000n)
      refuse("bounded-output-storage-required");
  }
  if (spec.contextFd !== undefined && !fstatSync(spec.contextFd).isSocket())
    refuse("context-must-be-socket");
  if (Number(statfsSync(spec.delegatedCgroup.procPath).type) !== CGROUP2_SUPER_MAGIC)
    refuse("cgroup-v2-required");
  if (readControl(spec.delegatedCgroup, "cgroup.procs") !== "") refuse("delegation-not-empty");
  const controllers = readControl(spec.delegatedCgroup, "cgroup.subtree_control").split(/\s+/);
  if (!["cpu", "memory", "pids"].every((name) => controllers.includes(name)))
    refuse("cpu-memory-pids-delegation-required");
  return Number(outputCapacity);
}

interface Groups {
  root: HeldDirectory;
  supervisor: HeldDirectory;
  scope: HeldDirectory;
  workloads: HeldDirectory;
  main: HeldDirectory;
  children: HeldDirectory;
}
function createGroups(parent: HeldDirectory, limits: LinuxJobLimits): Groups {
  const root = parent.openChild(`job-${randomUUID()}`, { create: true });
  const opened = [root];
  try {
    // Bounds live above the subtree the child can alter. No workload runs in this ancestor.
    writeControl(root, "memory.max", String(limits.memoryBytes));
    writeControl(root, "memory.swap.max", "0");
    writeControl(root, "memory.oom.group", "1");
    // One extra slot is reserved for the trusted bubblewrap supervisor.
    writeControl(root, "pids.max", String(limits.processes + 1));
    writeControl(root, "cgroup.subtree_control", "+cpu +memory +pids");
    const supervisor = root.openChild("supervisor", { create: true });
    opened.push(supervisor);
    const scope = root.openChild("scope", { create: true });
    opened.push(scope);
    writeControl(scope, "pids.max", String(limits.processes));
    writeControl(scope, "cgroup.subtree_control", "+cpu +memory +pids");
    const main = scope.openChild("main", { create: true });
    opened.push(main);
    // The contained engine is outside the delegated root. Its own controller can
    // require both an empty cgroup.procs and no pre-existing child cgroups.
    const workloads = scope.openChild("workloads", { create: true });
    opened.push(workloads);
    writeControl(workloads, "cgroup.subtree_control", "+cpu +memory +pids");
    const children = root.openChild("children", { create: true });
    opened.push(children);
    writeControl(children, "cgroup.subtree_control", "+cpu +memory +pids");
    // Migration/CLONE_INTO_CGROUP checks the common ancestor's cgroup.procs
    // inode permissions, not whether its pathname is mounted in the child.
    // Bubblewrap maps our real UID; require owner-write rather than relying on
    // supervisor capabilities or supplementary groups the sandbox will drop.
    for (const group of [scope, main, workloads]) {
      const fd = group.openFile("cgroup.procs", constants.O_WRONLY);
      try {
        const stat = fstatSync(fd);
        if (stat.uid !== process.getuid!() || (stat.mode & 0o200) === 0)
          refuse("cgroup-migration-permission-required");
      } finally {
        closeSync(fd);
      }
    }
    // Establish every required facility before even launching the trusted supervisor.
    readControl(root, "memory.peak");
    readControl(root, "cpu.stat");
    readControl(root, "memory.events");
    readControl(root, "pids.peak");
    for (const group of [root, scope, workloads, children]) {
      if (counter(readControl(group, "cgroup.events"), "populated") !== 0)
        refuse("cgroup-not-empty");
      writeControl(group, "cgroup.kill", "1");
    }
    return { root, supervisor, scope, workloads, main, children };
  } catch (error) {
    for (const directory of opened.reverse()) directory.close();
    throw error;
  }
}
function closeGroups(groups: Groups): void {
  // Deliberately retain the empty directories for owner reconciliation; do not recursively
  // delete attacker-created paths. The owner may remove held, proven-empty cgroups later.
  groups.children.close();
  groups.main.close();
  groups.workloads.close();
  groups.scope.close();
  groups.supervisor.close();
  groups.root.close();
}
async function awaitEmpty(group: HeldDirectory): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (counter(readControl(group, "cgroup.events"), "populated") !== 0) {
    if (performance.now() >= deadline) throw new LinuxJobRefusal("cgroup-empty-unproven");
    await delay(10);
  }
}
function childExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    signal: string | null;
  }>();
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
  return promise;
}
async function sandboxPid(stream: Readable, exited: Promise<unknown>): Promise<number> {
  const { promise: info, resolve, reject } = Promise.withResolvers<number>();
  let text = "";
  stream.on("data", (bytes: Buffer) => {
    if (text.length + bytes.length > 16384) {
      reject(new LinuxJobRefusal("invalid-sandbox-info"));
      stream.destroy();
      return;
    }
    text += bytes.toString("utf8");
  });
  stream.once("error", reject);
  stream.once("end", () => {
    try {
      const pid: unknown = JSON.parse(text)["child-pid"];
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
        refuse("invalid-sandbox-pid");
      resolve(pid as number);
    } catch {
      reject(new LinuxJobRefusal("invalid-sandbox-info"));
    }
  });
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new LinuxJobRefusal("sandbox-setup-timeout")),
    10_000,
  );
  try {
    return await Promise.race([
      info,
      exited.then(() => refuse("sandbox-setup-failed")),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Startup-only recovery, before admission; requires exclusive ownership of this delegation. */
export async function recoverLinuxJobs(delegatedRoot: HeldDirectory): Promise<void> {
  if (Number(statfsSync(delegatedRoot.procPath).type) !== CGROUP2_SUPER_MAGIC)
    refuse("cgroup-v2-required");
  for (const name of delegatedRoot.names()) {
    if (!/^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
    const group = delegatedRoot.openChild(name);
    try {
      writeControl(group, "cgroup.kill", "1");
      await awaitEmpty(group);
    } finally {
      group.close();
    }
  }
}

/** No shell, no PATH executable lookup, no inherited environment, no unconstrained fallback. */
export async function startLinuxJob(spec: LinuxJobSpec): Promise<LinuxJobHandle> {
  let namedOutputCapacity: number;
  let seccompFd: number;
  try {
    namedOutputCapacity = preflightLinuxJob(spec);
    seccompFd = privateByteFile(jobSeccompFilter());
  } catch (error) {
    throw observedStartRefusal(error);
  }
  let groups: Groups;
  try {
    groups = createGroups(spec.delegatedCgroup, spec.limits);
  } catch (error) {
    closeSync(seccompFd);
    throw observedStartRefusal(error);
  }
  let control: PrivateSocketPair;
  let report: PrivateSocketPair;
  try {
    control = privateSocketPair();
    try {
      report = privateSocketPair();
    } catch (error) {
      control.socket.destroy();
      closeSync(control.childFd);
      throw error;
    }
  } catch (error) {
    closeSync(seccompFd);
    closeGroups(groups);
    throw observedStartRefusal(error);
  }
  const gate = control.socket;
  const metadata = report.socket;
  gate.on("error", () => {});
  metadata.on("error", () => {});
  const stdio: Exclude<StdioOptions, string> = [
    "pipe",
    "pipe",
    "pipe",
    spec.contextFd ?? "ignore",
    control.childFd,
    report.childFd,
    seccompFd,
  ];
  // Do not unshare the cgroup namespace here: bubblewrap creates it before
  // reporting the child PID, so its root would precede our gated move to main.
  // Linux would then reject migration from main into sibling workloads (ENOENT).
  // The private mount/PID namespaces, dropped capabilities and workloads-only
  // held bind confine access instead; neither scope nor the enforcing root is mounted.
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--as-pid-1",
    "--die-with-parent",
    ...(spec.terminal ? [] : ["--new-session"]),
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--block-fd",
    "4",
    "--info-fd",
    "5",
    "--seccomp",
    "6",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    "/job",
    "--size",
    String(spec.limits.memoryBytes),
    "--perms",
    "0700",
    "--tmpfs",
    "/home/job",
    "--setenv",
    "HOME",
    "/home/job",
    "--setenv",
    "LANG",
    "C",
    "--setenv",
    "PATH",
    "/runtime/bin:/usr/bin:/bin",
    "--size",
    String(spec.limits.memoryBytes),
    "--perms",
    "1777",
    "--tmpfs",
    "/tmp",
  ];
  for (const [name, path] of [
    ["XDG_DATA_HOME", "/home/job/.local/share"],
    ["XDG_STATE_HOME", "/home/job/.local/state"],
    ["XDG_CACHE_HOME", "/home/job/.cache"],
    ["XDG_CONFIG_HOME", "/home/job/.config"],
    ["XDG_RUNTIME_DIR", "/home/job/.run"],
  ]) {
    args.push("--perms", "0700", "--dir", path!, "--setenv", name!, path!);
  }
  if (spec.network === "none") args.push("--unshare-net");
  if (spec.terminal)
    args.push("--setenv", "TERM", "xterm-256color", "--setenv", "COLORTERM", "truecolor");
  if (spec.contextFd !== undefined) args.push("--setenv", "MANIFOLD_JOB_CONTEXT_FD", "3");
  function bind(fd: number, target: string, writable: boolean): void {
    const slot = stdio.length;
    stdio.push(fd);
    // These options consume/close their descriptors before exec. Plain --bind proc paths
    // would leave inherited directory handles in the workload and bypass readonly mounts.
    args.push(writable ? "--bind-fd" : "--ro-bind-fd", String(slot), target);
  }
  bind(spec.artifactFd, "/job/artifact", false);
  for (const mount of [...spec.runtime, ...spec.locations, ...spec.outputs])
    bind(mount.fd, mount.target, mount.writable);
  let child: { readonly pid?: number | undefined; kill(signal: "SIGKILL"): unknown };
  let exited: Promise<{ code: number | null; signal: string | null }>;
  let stdin: ChildProcess["stdin"] = null;
  let stdout: ChildProcess["stdout"] = null;
  let stderr: ChildProcess["stderr"] = null;
  let outputBytes = 0;
  let sequence = 0;
  let reason: LinuxJobResult["reason"] = "exited";
  let fatal: unknown;
  let settled = false;
  let terminating = false;
  const terminalFailure = Promise.withResolvers<never>();
  void terminalFailure.promise.catch(() => {});
  function admitOutput(bytes: Uint8Array): boolean {
    outputBytes += bytes.byteLength;
    if (reason === "output-limit" || reason === "output-consumer") return false;
    if (outputBytes > spec.limits.outputBytes - namedOutputCapacity) {
      terminate("output-limit");
      return false;
    }
    return true;
  }
  spec.terminal?.setOutputHandler((bytes) => {
    if (!admitOutput(bytes)) return;
    try {
      spec.terminal!.onOutput(bytes);
    } catch {
      terminate("output-consumer");
    }
  });
  const inputFds: number[] = [];
  try {
    for (const file of spec.inputFiles ?? []) {
      // --ro-bind-fd resolves a host pathname and cannot mount an anonymous memfd.
      // Give --ro-bind-data its own offset-zero descriptor so repeated launches never
      // consume the caller's cursor; bubblewrap closes it after making a readonly bind.
      const fd = openSync(`/proc/self/fd/${file.fd}`, constants.O_RDONLY);
      inputFds.push(fd);
      const slot = stdio.length;
      stdio.push(fd);
      args.push("--perms", "0400", "--ro-bind-data", String(slot), file.target);
    }
    if (spec.nestedCgroup) {
      bind(groups.workloads.fd, "/sys/fs/cgroup/workloads", true);
      args.push("--setenv", "MANIFOLD_JOB_CGROUP_ROOT", "/sys/fs/cgroup/workloads");
    }
    args.push(
      "--chdir",
      spec.workingDirectory ?? "/home/job",
      "--remount-ro",
      "/",
      "--",
      spec.executableRuntimeTool === undefined
        ? "/job/artifact"
        : `/runtime/bin/${spec.executableRuntimeTool}`,
      ...spec.argv,
    );
    if (spec.terminal) {
      const proc = Bun.spawn([`/proc/${process.pid}/fd/${spec.bubblewrapFd}`, ...args], {
        stdio: [
          "inherit",
          "inherit",
          "inherit",
          ...stdio.slice(3).map((fd) => (typeof fd === "number" ? fd : "ignore")),
        ],
        terminal: spec.terminal.pty,
        env: {},
        cwd: "/",
      });
      child = proc;
      exited = proc.exited.then((code) => ({
        code: proc.signalCode ? null : code,
        signal: proc.signalCode ?? null,
      }));
    } else {
      const proc = spawn(`/proc/${process.pid}/fd/${spec.bubblewrapFd}`, args, {
        stdio,
        env: {},
        cwd: "/",
      });
      child = proc;
      exited = childExit(proc);
      stdin = proc.stdin;
      stdout = proc.stdout;
      stderr = proc.stderr;
    }
  } catch (error) {
    gate.destroy();
    metadata.destroy();
    closeGroups(groups);
    throw observedStartRefusal(error);
  } finally {
    closeSync(control.childFd);
    closeSync(report.childFd);
    closeSync(seccompFd);
    for (const fd of inputFds) closeSync(fd);
  }
  // Avoid an unhandled rejection while the launch gate is being attached.
  void exited.catch(() => {});
  function terminate(next: LinuxJobResult["reason"]): void {
    if (settled || terminating) return;
    terminating = true;
    if (reason === "exited") reason = next;
    stdin?.destroy();
    try {
      writeControl(groups.root, "cgroup.kill", "1");
      void awaitEmpty(groups.root).catch(terminalFailure.reject);
    } catch (error) {
      fatal = error;
      child.kill("SIGKILL");
      terminalFailure.reject(error);
    }
  }
  stdin?.on("error", () => terminate("input-error"));
  function consume(channel: "stdout" | "stderr", stream: Readable): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    stream.on("data", (bytes: Buffer) => {
      if (!admitOutput(bytes)) return;
      for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
        try {
          spec.onOutput?.({
            sequence: ++sequence,
            channel,
            bytes: bytes.subarray(offset, offset + FRAME_BYTES),
          });
        } catch {
          terminate("output-consumer");
          break;
        }
      }
    });
    stream.once("error", () => {
      terminate("output-consumer");
      resolve();
    });
    stream.once("close", resolve);
    return promise;
  }
  const drained = spec.terminal
    ? Promise.resolve([])
    : Promise.all([consume("stdout", stdout!), consume("stderr", stderr!)]);
  try {
    if (!child.pid) refuse("supervisor-spawn-failed");
    writeControl(groups.supervisor, "cgroup.procs", String(child.pid));
    const pid = await sandboxPid(metadata, exited);
    writeControl(groups.main, "cgroup.procs", String(pid));
    if (!readControl(groups.main, "cgroup.procs").split("\n").includes(String(pid)))
      refuse("cgroup-attachment-failed");
    // EOF also releases bubblewrap's gate: never close it on a failed launch until killed.
    if (reason !== "exited" || fatal) refuse("sandbox-setup-failed");
    gate.end(Buffer.from([1]));
  } catch (error) {
    settled = true;
    try {
      writeControl(groups.root, "cgroup.kill", "1");
    } catch {
      /* Still kill the namespace owner below. */
    }
    child.kill("SIGKILL");
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      writeControl(groups.root, "cgroup.kill", "1");
      child.kill("SIGKILL");
      await awaitEmpty(groups.root);
      if (cleaned) return;
      cleaned = true;
      gate.destroy();
      metadata.destroy();
      closeGroups(groups);
    };
    try {
      await cleanup();
    } catch (failure) {
      const code = failure instanceof LinuxJobRefusal ? failure.code : "startup-empty-unproven";
      throw new LinuxJobRefusal(code, code, false, cleanup);
    }
    throw observedStartRefusal(error);
  }
  const startedAt = Date.now();
  const timer = setTimeout(() => terminate("timeout"), spec.limits.timeoutMs);
  const result = (async (): Promise<LinuxJobResult> => {
    try {
      const exit = await Promise.race([exited, terminalFailure.promise]);
      // Even an apparently successful leader may have left descendants. Kill and observe
      // the whole group before any consumer may seal or publish its output directory.
      writeControl(groups.root, "cgroup.kill", "1");
      await awaitEmpty(groups.root);
      await drained;
      if (fatal) throw fatal;
      const finishedAt = Date.now();
      return {
        exitCode: exit.code,
        signal: exit.signal,
        reason,
        startedAt,
        finishedAt,
        empty: true,
        boundary: "linux-bubblewrap-cgroup-v2",
        usage: {
          wallMs: finishedAt - startedAt,
          cpuUsec: counter(readControl(groups.root, "cpu.stat"), "usage_usec"),
          memoryPeakBytes: counter(`peak ${readControl(groups.root, "memory.peak")}`, "peak"),
          outputBytes,
          processesPeak: counter(`peak ${readControl(groups.root, "pids.peak")}`, "peak"),
          oomKills: counter(readControl(groups.root, "memory.events"), "oom_kill"),
        },
      };
    } finally {
      settled = true;
      clearTimeout(timer);
      stdin?.destroy();
      gate.destroy();
      metadata.destroy();
    }
  })();
  let inputPending = false;
  let released = false;
  if (!spec.bidirectional) stdin?.end();
  return {
    result,
    childDelegation: groups.children,
    ownsLoopbackListener(port) {
      return (
        !released &&
        !settled &&
        !terminating &&
        spec.network === "host" &&
        ownsWorkloadLoopbackListener(groups, port)
      );
    },
    release() {
      if (released) return;
      if (!settled || counter(readControl(groups.root, "cgroup.events"), "populated") !== 0)
        refuse("job-still-active");
      released = true;
      closeGroups(groups);
    },
    input(bytes) {
      if (!stdin || !spec.bidirectional || settled || stdin.destroyed || stdin.writableEnded)
        return Promise.reject(new LinuxJobRefusal("input-closed"));
      if (inputPending || bytes.byteLength > FRAME_BYTES)
        return Promise.reject(new LinuxJobRefusal("input-backpressure"));
      inputPending = true;
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      stdin.write(Buffer.from(bytes), (error) => {
        inputPending = false;
        if (error) reject(new LinuxJobRefusal("input-closed"));
        else resolve();
      });
      return promise;
    },
    endInput() {
      stdin?.end();
    },
    cancel() {
      if (!settled) terminate("cancelled");
      return result;
    },
  };
}
