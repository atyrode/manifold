import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const CPU_ROOT = "/sys/devices/system/cpu";
const MAX_ONLINE_BYTES = 65_536;
const MAX_ONLINE_CPUS = 8_192;
const MAX_CPU_ID = 65_535;
const MAX_ID_BYTES = 32;

/** Bounded native observations; the seam lets tests model missing files and CPU hotplug. */
export interface MachineTopologyOptions {
  readonly platform?: string;
  readonly read?: (path: string, maxBytes: number) => string | undefined;
}

function readSysfs(path: string, maxBytes: number): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = readSync(fd, buffer, length, buffer.length - length, null);
      if (size === 0) return buffer.subarray(0, length).toString("utf8");
      length += size;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function onlineCpus(text: string | undefined): number[] | undefined {
  if (text === undefined || text.length > MAX_ONLINE_BYTES) return undefined;
  const list = text.trim();
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(list)) return undefined;
  const cpus: number[] = [];
  let previous = -1;
  for (const range of list.split(",")) {
    const [first, last = first] = range.split("-");
    const start = Number(first);
    const end = Number(last);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= previous ||
      end < start ||
      end > MAX_CPU_ID ||
      cpus.length + end - start + 1 > MAX_ONLINE_CPUS
    )
      return undefined;
    for (let cpu = start; cpu <= end; cpu++) cpus.push(cpu);
    previous = end;
  }
  return cpus;
}

function topologyId(text: string | undefined): number | undefined {
  if (text === undefined || text.length > MAX_ID_BYTES || !/^\d+\s*$/.test(text)) return undefined;
  const id = Number(text.trim());
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/**
 * Distinct OS-visible (physical_package_id, core_id) pairs among online Linux CPUs.
 * This is not bare-metal attestation or schedulable quota. No logical-CPU fallback exists.
 * Two complete topology passes bracketed by online snapshots must agree: an incomplete,
 * changing, malformed or over-bound observation is unknown, with no retry or cached fact.
 */
export function readPhysicalCoreCount(options: MachineTopologyOptions = {}): number | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const read = options.read ?? readSysfs;
  try {
    const before = read(`${CPU_ROOT}/online`, MAX_ONLINE_BYTES);
    const cpus = onlineCpus(before);
    if (cpus === undefined) return undefined;
    const identities: string[] = [];
    const cores = new Set<string>();
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < cpus.length; index++) {
        const topology = `${CPU_ROOT}/cpu${cpus[index]}/topology`;
        const packageId = topologyId(read(`${topology}/physical_package_id`, MAX_ID_BYTES));
        const coreId = topologyId(read(`${topology}/core_id`, MAX_ID_BYTES));
        if (packageId === undefined || coreId === undefined) return undefined;
        const identity = `${packageId}:${coreId}`;
        if (pass === 0) {
          identities.push(identity);
          cores.add(identity);
        } else if (identities[index] !== identity) {
          return undefined;
        }
      }
      if (read(`${CPU_ROOT}/online`, MAX_ONLINE_BYTES) !== before) return undefined;
    }
    return cores.size > 0 ? cores.size : undefined;
  } catch {
    // Unavailable native topology is explicitly unknown; it must not prevent the hello.
    return undefined;
  }
}
