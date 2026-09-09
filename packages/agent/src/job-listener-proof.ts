import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
  statfsSync,
} from "node:fs";
import { CLOSE_ON_EXEC, HeldDirectory } from "./job-files.ts";

// Linux procfs, cgroup-v2 and nsfs superblock identities; never accept lookalike files.
const PROC_SUPER_MAGIC = 0x9fa0;
const CGROUP2_SUPER_MAGIC = 0x63677270;
const NSFS_MAGIC = 0x6e736673;
// O_PATH follows a proc FD magic link without opening/reading the underlying device.
const O_PATH = 0x200000;
const MAX_GROUPS = 128;
const MAX_DEPTH = 16;
const MAX_PROCESSES = 256;
const MAX_DESCRIPTORS = 4096;
const MAX_TABLE_BYTES = 2 * 1024 * 1024;
const MAX_TABLE_ROWS = 8192;

interface Authority {
  scope: HeldDirectory;
  main: HeldDirectory;
  workloads: HeldDirectory;
}

function identity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function boundedText(directory: HeldDirectory, name: string, limit: number): string {
  const fd = directory.openFile(name);
  try {
    const bytes = Buffer.allocUnsafe(limit + 1);
    let used = 0;
    while (used <= limit) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) return bytes.toString("utf8", 0, used);
      used += count;
    }
    throw new Error("listener_metadata_limit");
  } finally {
    closeSync(fd);
  }
}

function members(group: HeldDirectory): Set<string> {
  const text = boundedText(group, "cgroup.procs", MAX_PROCESSES * 12);
  const pids = new Set<string>();
  for (const line of text.trim().split("\n")) {
    if (!line && !text.trim()) break;
    if (!/^[1-9][0-9]{0,9}$/.test(line)) throw new Error("listener_invalid_pid");
    pids.add(line);
    if (pids.size > MAX_PROCESSES) throw new Error("listener_process_limit");
  }
  return pids;
}

function processStart(proc: HeldDirectory, pid: string): string {
  // comm is untrusted and may contain spaces, newlines and closing parentheses.
  const stat = boundedText(proc, "stat", 4096);
  if (!stat.startsWith(`${pid} (`)) throw new Error("listener_pid_namespace_mismatch");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  // stat fields 3 (state) and 22 (starttime), relative to the end of comm.
  if (!fields[0] || !/^[RSDTtWIKP]$/.test(fields[0]) || !/^\d+$/.test(fields[19] ?? ""))
    throw new Error("listener_process_not_live");
  return fields[19]!;
}

function netNamespace(proc: HeldDirectory): number {
  const ns = proc.openChild("ns");
  try {
    // This one intentional magic-link traversal retains the actual kernel namespace.
    const fd = openSync(`${ns.procPath}/net`, constants.O_RDONLY | CLOSE_ON_EXEC);
    try {
      if (Number(statfsSync(`/proc/self/fd/${fd}`).type) !== NSFS_MAGIC)
        throw new Error("listener_namespace_unproven");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } finally {
    ns.close();
  }
}

function listenerInode(net: HeldDirectory, port: number): bigint | undefined {
  const rows = boundedText(net, "tcp", MAX_TABLE_BYTES).trim().split("\n");
  if (
    rows.length > MAX_TABLE_ROWS ||
    !/^\s*sl\s+local_address\s+rem_address\s+st\s/.test(rows[0] ?? "")
  )
    throw new Error("listener_table_unproven");
  let inode: bigint | undefined;
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const row of rows.slice(1)) {
    const fields = row.trim().split(/\s+/);
    if (
      fields.length < 10 ||
      !/^\d+:$/.test(fields[0]!) ||
      !/^[0-9A-F]{8}:[0-9A-F]{4}$/.test(fields[1]!) ||
      !/^[0-9A-F]{8}:[0-9A-F]{4}$/.test(fields[2]!) ||
      !/^[0-9A-F]{2}$/.test(fields[3]!) ||
      !/^\d+$/.test(fields[9]!)
    )
      throw new Error("listener_table_unproven");
    // TCP_LISTEN = 0A; proc tcp IPv4 addresses are printed in native byte order.
    // The runtime supports Linux x64/arm64 little-endian hosts only.
    if (fields[3] !== "0A" || fields[1]!.slice(9) !== hexPort) continue;
    if (fields[1]!.startsWith("00000000:")) throw new Error("listener_wildcard");
    if (!fields[1]!.startsWith("0100007F:")) continue;
    if (inode !== undefined || fields[2] !== "00000000:0000" || fields[9] === "0")
      throw new Error("listener_ambiguous");
    inode = BigInt(fields[9]!);
  }
  return inode;
}

function withinAuthority(group: HeldDirectory, authority: Authority): boolean {
  const scope = identity(authority.scope.fd);
  const roots = new Set([identity(authority.main.fd), identity(authority.workloads.fd)]);
  let fd = openSync(
    `${group.procPath}/.`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC,
  );
  try {
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const current = identity(fd);
      const parent = openSync(
        `/proc/self/fd/${fd}/..`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC,
      );
      closeSync(fd);
      fd = parent;
      if (roots.has(current)) return identity(parent) === scope;
      if (identity(parent) === current) return false;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** A bounded, synchronous observation, not a reservation of the port after return.
 * Only cgroup members with a retained live proc directory and a pinned socket inode
 * can prove ownership. The supervisor and separately admitted children are not roots.
 * Missing permissions, races, ambiguity or resource bounds all refuse readiness. */
export function ownsWorkloadLoopbackListener(authority: Authority, port: number): boolean {
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return false;
  const held: HeldDirectory[] = [];
  const namespaces: number[] = [];
  const deadline = performance.now() + 250;
  const checkTime = () => {
    if (performance.now() > deadline) throw new Error("listener_time_limit");
  };
  try {
    for (const group of [authority.scope, authority.main, authority.workloads]) {
      if (Number(statfsSync(group.procPath).type) !== CGROUP2_SUPER_MAGIC) return false;
    }
    if (!/^populated 1$/m.test(boundedText(authority.scope, "cgroup.events", 1024))) return false;
    const procRoot = HeldDirectory.openAbsolute("/proc");
    held.push(procRoot);
    if (Number(statfsSync(procRoot.procPath).type) !== PROC_SUPER_MAGIC) return false;
    const self = procRoot.openChild(String(process.pid));
    held.push(self);
    processStart(self, String(process.pid));
    // cgroup.procs reports PIDs in the reader's namespace: verify procfs agrees.
    const actualSelf = openSync(
      `${procRoot.procPath}/self`,
      constants.O_RDONLY | constants.O_DIRECTORY | CLOSE_ON_EXEC,
    );
    try {
      if (identity(actualSelf) !== identity(self.fd)) return false;
    } finally {
      closeSync(actualSelf);
    }
    const ownerNet = netNamespace(self);
    namespaces.push(ownerNet);
    const net = self.openChild("net");
    held.push(net);
    const inode = listenerInode(net, port);
    if (inode === undefined) return false;

    const queue = [
      { group: authority.main, depth: 0 },
      { group: authority.workloads, depth: 0 },
    ];
    const processes: { group: HeldDirectory; pid: string }[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      checkTime();
      const { group, depth } = queue[index]!;
      if (!withinAuthority(group, authority)) return false;
      for (const pid of members(group)) {
        if (seen.has(pid) || processes.length >= MAX_PROCESSES) return false;
        seen.add(pid);
        processes.push({ group, pid });
      }
      const directory = opendirSync(group.procPath, { bufferSize: 16 });
      try {
        let entries = 0;
        for (let entry; (entry = directory.readSync()) !== null;) {
          checkTime();
          // cgroup control files are bounded too; never materialize an unbounded readdir.
          if (++entries > 256) return false;
          if (!entry.isDirectory()) continue;
          if (depth >= MAX_DEPTH || queue.length >= MAX_GROUPS) return false;
          const child = group.openChild(entry.name);
          held.push(child);
          queue.push({ group: child, depth: depth + 1 });
        }
      } finally {
        directory.closeSync();
      }
    }
    let descriptors = 0;
    for (const { group, pid } of processes) {
      checkTime();
      // Holding this proc inode prevents PID reuse from redirecting later reads.
      const proc = procRoot.openChild(pid);
      try {
        const start = processStart(proc, pid);
        if (!members(group).has(pid)) return false;
        const processNet = netNamespace(proc);
        try {
          if (identity(processNet) !== identity(ownerNet)) return false;
        } finally {
          closeSync(processNet);
        }
        const fds = proc.openChild("fd");
        try {
          const directory = opendirSync(fds.procPath, { bufferSize: 16 });
          try {
            for (let entry; (entry = directory.readSync()) !== null;) {
              checkTime();
              if (
                ++descriptors > MAX_DESCRIPTORS ||
                !/^\d{1,10}$/.test(entry.name) ||
                !entry.isSymbolicLink()
              )
                return false;
              const path = `${fds.procPath}/${entry.name}`;
              // The kernel resolves one FD slot in the held task, retaining its inode.
              // No readlink/check/reopen pathname or attacker-chosen symlink is involved.
              const socket = openSync(path, O_PATH | CLOSE_ON_EXEC);
              try {
                const stat = fstatSync(socket, { bigint: true });
                if (!stat.isSocket() || stat.ino !== inode) continue;
                if (
                  listenerInode(net, port) !== inode ||
                  !withinAuthority(group, authority) ||
                  !members(group).has(pid) ||
                  processStart(proc, pid) !== start
                )
                  return false;
                const finalNet = netNamespace(proc);
                try {
                  if (identity(finalNet) !== identity(ownerNet)) return false;
                } finally {
                  closeSync(finalNet);
                }
                // An FD closed/replaced during the observation must not pass on stale inode evidence.
                const current = openSync(path, O_PATH | CLOSE_ON_EXEC);
                try {
                  checkTime();
                  return (
                    identity(current) === identity(socket) &&
                    fstatSync(current).isSocket() &&
                    processStart(proc, pid) === start
                  );
                } finally {
                  closeSync(current);
                }
              } finally {
                closeSync(socket);
              }
            }
          } finally {
            directory.closeSync();
          }
        } finally {
          fds.close();
        }
      } finally {
        proc.close();
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    for (const fd of namespaces) closeSync(fd);
    for (const directory of held.reverse()) directory.close();
  }
}
