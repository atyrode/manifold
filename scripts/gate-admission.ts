/**
 * The gate's one task scheduler: registry order, a fixed per-schedule cap, and memory-aware
 * admission, so that a gate on a shared host cannot start its whole fan-out regardless of the
 * memory actually left.
 *
 * Rule. A schedule always starts a task when none of its own tasks is running, so every gate
 * completes. Below its cap it starts the next task only when a fresh reading of the host's
 * available memory, less what the tasks already started may still claim, covers one more task
 * budget. A started task may still claim its budget less its process tree's current resident
 * size (never below zero); a task whose process tree is not observable yet claims its whole
 * budget. A task that has just started therefore counts at full size before it grows: a host that
 * can hold a cap's worth of budgets beside its other load keeps the full cap, and a host that
 * cannot runs fewer tasks at once, down to one. While memory is short, admission waits for a
 * running task to finish or for the next re-check, whichever comes first, and logs one
 * `gate: waiting for memory …` line per wait. Task order, caps and phases are unchanged.
 *
 * Budget. The default, 2 GiB, rests on peak resident sizes of whole task process trees measured
 * one task at a time on x86_64 Linux (2026-09-26): unit tests 2119 MiB and testkit e2e 2628 MiB,
 * both including short-lived Chromium children; tsc 498–1253 MiB, server the largest; eslint
 * 966 MiB; web build 878 MiB; prettier 611 MiB. It covers every compiler, linter and build with
 * room to spare, while the two suites exceed it only through transient browser children whose
 * actual size admission then counts. A larger default would cost a 16 GB hosted CI runner, whose
 * available memory holds six such budgets, its six-wide type shards.
 * `MANIFOLD_GATE_TASK_MEMORY_MIB` overrides it with a whole number of MiB for a constrained or
 * dedicated machine, and `0` turns admission off so that the cap alone schedules.
 *
 * Memory source (Linux). `MemAvailable` from `/proc/meminfo`, bounded by the headroom of every
 * cgroup v2 level containing this process that sets a finite `memory.max`: that limit less the
 * level's working set, `memory.current` minus reclaimable `inactive_file`. A task's process tree
 * is one child of this process with its descendants, measured by summed `VmRSS`. On other
 * platforms memory reads as unknown and the cap alone applies, because `os.freemem()` on macOS
 * excludes reclaimable cache and would serialize an idle machine. An unreadable source also
 * falls back to the cap.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIB = 1024 * 1024;

/** The default task budget; the header records its measured basis. */
export const DEFAULT_TASK_MEMORY_MIB = 2048;

/** How long a memory-short schedule waits for a finishing task before reading memory again. */
const RECHECK_MS = 1000;

/** One schedulable task: its registry name, for diagnostics, and the work itself. */
export interface ScheduledJob<T> {
  readonly name: string;
  readonly run: () => Promise<T>;
}

/** One reading of the host's memory, in bytes. */
export interface MemoryReading {
  /** What the host can still allocate before reclaiming anyone's working set. */
  readonly available: number;
  /** The resident size of each task process tree this gate has started and not yet reaped. */
  readonly taskResident: readonly number[];
}

/** The admission policy one gate run shares across its schedules. */
export interface Admission {
  /** Bytes one task may grow to; `0` turns memory admission off. */
  readonly budget: number;
  /** The current reading, or null when the host's memory cannot be read. */
  readonly readMemory: () => MemoryReading | null;
  /** Resolves when a memory-short schedule should read memory again. */
  readonly recheck: () => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * Parses `MANIFOLD_GATE_TASK_MEMORY_MIB` into a budget in bytes: unset or empty is the default,
 * otherwise a whole number of MiB where `0` turns admission off. Null when malformed.
 */
export function taskMemoryBudget(value: string | undefined): number | null {
  if (value === undefined || value === "") return DEFAULT_TASK_MEMORY_MIB * MIB;
  if (!/^\d+$/.test(value)) return null;
  const bytes = Number(value) * MIB;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function mib(bytes: number): number {
  return Math.floor(bytes / MIB);
}

/**
 * Runs `jobs` in order with at most `cap` running, admitting each one beyond the first by
 * `admission` as the header describes. Results keep job order. A job that rejects rejects the
 * schedule the next time the schedule waits, and nothing starts after that.
 */
export async function runAdmitted<T>(
  cap: number,
  jobs: readonly ScheduledJob<T>[],
  admission: Admission,
): Promise<T[]> {
  const results: T[] = [];
  const running = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const settle = async (recheck?: Promise<void>): Promise<void> => {
    await Promise.race(recheck === undefined ? running : [...running, recheck]);
    if (errors.length > 0) throw errors[0];
  };

  for (const [index, job] of jobs.entries()) {
    while (running.size >= cap) await settle();
    let waiting = false;
    while (running.size > 0 && admission.budget > 0) {
      const reading = admission.readMemory();
      if (reading === null) break;
      let reserved = Math.max(0, running.size - reading.taskResident.length) * admission.budget;
      for (const resident of reading.taskResident) {
        reserved += Math.max(0, admission.budget - resident);
      }
      if (reading.available - reserved >= admission.budget) break;
      if (!waiting) {
        admission.log(
          `gate: waiting for memory before starting ${job.name}: ` +
            `${mib(reading.available)} MiB available, ${mib(reserved)} MiB reserved by ` +
            `started tasks, ${mib(admission.budget)} MiB budget`,
        );
        waiting = true;
      }
      await settle(admission.recheck());
    }
    const settled: Promise<void> = job
      .run()
      .then(
        (result) => {
          results[index] = result;
        },
        (error: unknown) => {
          errors.push(error);
        },
      )
      .finally(() => {
        running.delete(settled);
      });
    running.add(settled);
  }
  while (running.size > 0) await settle();
  return results;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function wholeNumber(text: string | null): number | null {
  const trimmed = text?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** One cgroup v2 level's memory files, each null when the level lacks it. */
export interface CgroupMemoryFiles {
  readonly max: string | null;
  readonly current: string | null;
  readonly stat: string | null;
}

/**
 * Bytes the host can still allocate: `MemAvailable`, bounded at every cgroup level with a finite
 * `memory.max` by that limit less the level's working set (`memory.current` minus reclaimable
 * `inactive_file`). Null when `MemAvailable` is unreadable.
 */
export function availableMemory(
  meminfo: string | null,
  cgroups: readonly CgroupMemoryFiles[],
): number | null {
  const kib = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo ?? "")?.[1];
  if (kib === undefined) return null;
  let available = Number(kib) * 1024;
  for (const level of cgroups) {
    const limit = wholeNumber(level.max);
    const current = wholeNumber(level.current);
    if (limit === null || current === null) continue;
    const inactive = Number(/^inactive_file (\d+)$/m.exec(level.stat ?? "")?.[1] ?? 0);
    available = Math.min(available, Math.max(0, limit - Math.max(0, current - inactive)));
  }
  return available;
}

/** This process's cgroup v2 levels, innermost first; empty outside cgroup v2. */
function cgroupLevels(): CgroupMemoryFiles[] {
  const membership = readText("/proc/self/cgroup")
    ?.split("\n")
    .find((line) => line.startsWith("0::"));
  if (membership === undefined) return [];
  const segments = membership
    .slice(3)
    .split("/")
    .filter((segment) => segment !== "");
  const levels: CgroupMemoryFiles[] = [];
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const directory = join("/sys/fs/cgroup", ...segments.slice(0, depth));
    levels.push({
      max: readText(join(directory, "memory.max")),
      current: readText(join(directory, "memory.current")),
      stat: readText(join(directory, "memory.stat")),
    });
  }
  return levels;
}

/** Children of `pid` from each thread's `children` list; empty when the kernel hides them. */
function childPids(pid: number): number[] {
  let threads: string[];
  try {
    threads = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const children: number[] = [];
  for (const thread of threads) {
    const listed = readText(`/proc/${pid}/task/${thread}/children`) ?? "";
    for (const child of listed.split(/\s+/)) if (child !== "") children.push(Number(child));
  }
  return children;
}

/** The summed `VmRSS` of `root` and its descendants; a process that vanishes counts as zero. */
function treeResident(root: number): number {
  let resident = 0;
  const pending = [root];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    const kib = /^VmRSS:\s+(\d+) kB$/m.exec(readText(`/proc/${pid}/status`) ?? "")?.[1];
    resident += Number(kib ?? 0) * 1024;
    pending.push(...childPids(pid));
  }
  return resident;
}

/** The Linux reading the header describes; null elsewhere or when unreadable. */
export function readHostMemory(): MemoryReading | null {
  if (process.platform !== "linux") return null;
  const available = availableMemory(readText("/proc/meminfo"), cgroupLevels());
  if (available === null) return null;
  return { available, taskResident: childPids(process.pid).map((pid) => treeResident(pid)) };
}

/** The admission a gate run uses on this host, logging to standard output beside PASS/FAIL. */
export function hostAdmission(budget: number): Admission {
  return {
    budget,
    readMemory: readHostMemory,
    recheck: () => Bun.sleep(RECHECK_MS),
    log: (line) => console.log(line),
  };
}
