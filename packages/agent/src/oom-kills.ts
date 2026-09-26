import { readFileSync } from "node:fs";

/**
 * Whether the terminal host's destructive stop followed a kernel OOM kill (issue #853).
 *
 * systemd's default `OOMPolicy=stop` turns one OOM-killed descendant into a stop of the whole
 * unit, and that stop reaches the host as an ordinary SIGTERM. The only local evidence is the
 * host cgroup's cumulative cgroup v2 `memory.events` `oom_kill` counter, which carries no
 * timestamp. So the host samples it on a cadence, stamps when it first saw it rise, and at stop
 * time samples once more: a rise since the last sample, or one first seen within the window,
 * means the stop followed an OOM kill. An old rise does not, so a later deliberate stop is not
 * blamed on a kill the host survived.
 */

/** How often a running host samples its cgroup's OOM-kill counter. */
export const OOM_KILL_SAMPLE_INTERVAL_MS = 5_000;

/** How long after a kill was first seen a stop is still attributed to it. */
export const OOM_KILL_STOP_WINDOW_MS = 30_000;

/** Reads a cumulative kernel OOM-kill count; null when it cannot be read right now. */
export type OomKillCounter = () => number | null;

/**
 * The counter for THIS process's cgroup v2 cgroup, read from `/proc/self/cgroup` once, or null
 * when there is nothing to observe: not Linux, no unified hierarchy, or no readable
 * `memory.events` there (the root cgroup, or no memory controller). The cgroup is the host's own
 * leaf; `memory.events` counts kills in that cgroup and every cgroup below it.
 */
export function cgroupOomKillCounter(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  cgroupRoot = "/sys/fs/cgroup",
): OomKillCounter | null {
  let membership: string;
  try {
    membership = read("/proc/self/cgroup");
  } catch {
    return null;
  }
  const unified = membership.split("\n").find((line) => line.startsWith("0::"));
  if (unified === undefined) return null;
  const cgroup = unified.slice("0::".length).trim();
  if (!cgroup.startsWith("/")) return null;
  const events = `${cgroupRoot}${cgroup === "/" ? "" : cgroup}/memory.events`;
  const counter: OomKillCounter = () => {
    try {
      return oomKillCount(read(events));
    } catch {
      return null;
    }
  };
  return counter() === null ? null : counter;
}

/** The `oom_kill` value of one `memory.events` document, or null when it has none. */
function oomKillCount(memoryEvents: string): number | null {
  for (const line of memoryEvents.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key !== "oom_kill" || value === undefined || !/^\d+$/.test(value)) continue;
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  return null;
}

export class OomKillWatch {
  private last: number | null;
  private firstSeenAt: number | null = null;

  constructor(
    private readonly counter: OomKillCounter,
    private readonly now: () => number,
  ) {
    this.last = counter();
  }

  /** Takes one sample; a rise over the previous readable sample is stamped with now. */
  sample(): void {
    const count = this.counter();
    if (count === null) return;
    if (this.last !== null && count > this.last) this.firstSeenAt = this.now();
    this.last = count;
  }

  /** Samples now, then answers whether a kill was first seen within the stop window. */
  killedRecently(): boolean {
    this.sample();
    return this.firstSeenAt !== null && this.now() - this.firstSeenAt <= OOM_KILL_STOP_WINDOW_MS;
  }
}
