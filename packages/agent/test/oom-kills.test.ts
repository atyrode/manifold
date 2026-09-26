import { expect, test } from "bun:test";
import {
  OOM_KILL_SAMPLE_INTERVAL_MS,
  OOM_KILL_STOP_WINDOW_MS,
  OomKillWatch,
  cgroupOomKillCounter,
} from "../src/oom-kills.ts";

/** A fake procfs/cgroupfs: absent paths throw exactly as an unreadable file does. */
function files(entries: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = entries[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

const EVENTS = (oomKills: number) =>
  `low 0\nhigh 0\nmax 12\noom 3\noom_kill ${String(oomKills)}\noom_group_kill 0\n`;

test("the host reads its own unified cgroup's oom_kill counter, and nothing it cannot see", () => {
  const unit = "/user.slice/user-1000.slice/user@1000.service/app.slice/terminal-host.service";
  const cgroupFiles: Record<string, string> = {
    // A hybrid host lists v1 controllers too; only the unified `0::` line names the v2 cgroup.
    "/proc/self/cgroup": `12:memory:/legacy\n0::${unit}\n`,
    [`/sys/fs/cgroup${unit}/memory.events`]: EVENTS(4),
  };
  const counter = cgroupOomKillCounter(files(cgroupFiles));
  expect(counter?.()).toBe(4);
  cgroupFiles[`/sys/fs/cgroup${unit}/memory.events`] = EVENTS(5);
  expect(counter?.()).toBe(5);
  delete cgroupFiles[`/sys/fs/cgroup${unit}/memory.events`];
  expect(counter?.()).toBeNull();

  // A cgroup namespace shows its own root as `/`, whose events live at the mount root.
  expect(
    cgroupOomKillCounter(
      files({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.events": EVENTS(2) }),
    )?.(),
  ).toBe(2);
  // Not Linux, cgroup v1 only, no memory controller, or no counter: no observation at all.
  expect(cgroupOomKillCounter(files({}))).toBeNull();
  expect(cgroupOomKillCounter(files({ "/proc/self/cgroup": "4:memory:/unit\n" }))).toBeNull();
  expect(cgroupOomKillCounter(files({ "/proc/self/cgroup": `0::${unit}\n` }))).toBeNull();
  expect(
    cgroupOomKillCounter(
      files({
        "/proc/self/cgroup": `0::${unit}\n`,
        [`/sys/fs/cgroup${unit}/memory.events`]: "low 0\noom 1\n",
      }),
    ),
  ).toBeNull();
});

test("only a kill seen just before the stop is blamed for it", () => {
  let count = 1;
  let now = 1_000_000;
  const fresh = () =>
    new OomKillWatch(
      () => count,
      () => now,
    );

  // No rise since the host started watching: a plain stop.
  expect(fresh().killedRecently()).toBe(false);

  // A kill between the last sample and the stop (systemd's OOMPolicy=stop reaction).
  const racing = fresh();
  racing.sample();
  count += 1;
  expect(racing.killedRecently()).toBe(true);

  // A kill a sample already saw still counts inside the window...
  const sampled = fresh();
  count += 1;
  now += OOM_KILL_SAMPLE_INTERVAL_MS;
  sampled.sample();
  now += OOM_KILL_STOP_WINDOW_MS;
  expect(sampled.killedRecently()).toBe(true);
  // ...and a kill the host survived long ago never explains a later stop.
  now += 1;
  expect(sampled.killedRecently()).toBe(false);

  // An unreadable sample neither proves nor erases a rise.
  let readable = true;
  const flaky = new OomKillWatch(
    () => (readable ? count : null),
    () => now,
  );
  readable = false;
  flaky.sample();
  readable = true;
  count += 1;
  expect(flaky.killedRecently()).toBe(true);
});
