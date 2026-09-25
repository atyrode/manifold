import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The ordinary unit/e2e gates already execute every portable case in these files.
// Select only tests whose skip conditions are unlocked by this delegated Linux
// fixture, so the runtime proof does not repeat unconditional tests.
const fixtureTestPattern = [
  "\\[real-linux\\]",
  "never-admitted (?:expired|status|cancel|retire|recovered-status) starts close durably without accepting forged absence or replay",
  "bundled (?:primary|managed|companion) execution survives missing optional tools and owner recovery without replay",
  "real owner refuses (?:aggregate|full-blocks|full-inodes|location-inodes) output storage without publishing incomplete archives",
  "native direct invocation projects PATCH results and binds cancellation and owner authorization to invoke",
  "reacquired runtime artifacts restore dependent service readiness without new configuration",
  "(?:read|tunnel) service authority refreshes a changed runtime before seeking a hub grant",
  "(?:read|tunnel) service authority waits for a late hub answer, walks runtime tools once, and only a denial refuses",
  "instance retirement preserves native (?:cooperative|lost-completion|launch-race|noncooperative) ownership until confirmed exit",
  "real machine jobs enforce consent, execute once across transport replacement, and fence queued revocation",
  "instance services survive hub and transport replacement and route only current cross-owner authority",
  "contextual (?:policy inventory|readiness keeps|recovery retains)",
  "an explicit provider resolves contextual dependencies against its callee installation, not its foreign caller",
  "owner upgrade restores an exact older install projection without changing pinned authority",
  "outside-set owner RPC never blocks drained empty native maintenance shutdown",
].join("|");

// Run only inside a disposable delegated systemd unit, never in the caller's normal cgroup.
const unit = process.env.MANIFOLD_TEST_UNIT;
if (
  process.platform !== "linux" ||
  !unit ||
  !/^manifold-jobs-[A-Za-z0-9_.-]+$/.test(unit) ||
  !process.env.MANIFOLD_TEST_BWRAP ||
  !process.env.MANIFOLD_TEST_STATIC_BUSYBOX ||
  !process.env.MANIFOLD_TEST_SYSCALL_PROBE ||
  !process.env.MANIFOLD_TEST_LISTENER_PROBE ||
  !process.env.MANIFOLD_TEST_INSTANCE_SERVICE ||
  !process.env.MANIFOLD_TEST_OUTPUT_ROOT ||
  !process.env.MANIFOLD_TEST_MOUNT_TREE
) {
  throw new Error(
    "verify:jobs requires a private manifold-jobs-* delegated Linux unit, bubblewrap/static BusyBox/syscall and listener probes, and bounded output/mount fixtures",
  );
}
const membership = readFileSync("/proc/self/cgroup", "utf8")
  .split("\n")
  .find((line) => line.startsWith("0::"))
  ?.slice(3);
if (!membership?.endsWith(`/${unit}.service`)) {
  throw new Error("verify:jobs refuses a cgroup outside its named disposable unit");
}
const root = `/sys/fs/cgroup${membership}`;
const controllers = readFileSync(`${root}/cgroup.controllers`, "utf8").trim().split(/\s+/);
if (["cpu", "memory", "pids"].some((name) => !controllers.includes(name))) {
  throw new Error("verify:jobs requires delegated cpu, memory and pids controllers");
}
mkdirSync(`${root}/supervisor`);
for (const pid of readFileSync(`${root}/cgroup.procs`, "utf8").trim().split(/\s+/)) {
  if (pid) writeFileSync(`${root}/supervisor/cgroup.procs`, pid);
}
writeFileSync(`${root}/cgroup.subtree_control`, "+cpu +memory +pids");
const workloads = `${root}/workloads`;
mkdirSync(workloads);
writeFileSync(`${workloads}/cgroup.subtree_control`, "+cpu +memory +pids");
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "packages/agent/src/job-linux.test.ts",
    "packages/agent/test/job-owner.test.ts",
    "packages/agent/test/job-runtime.test.ts",
    "packages/testkit/e2e/jobs.test.ts",
    "packages/testkit/e2e/instance-services.test.ts",
    "--test-name-pattern",
    fixtureTestPattern,
    "--timeout",
    "120000",
  ],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, MANIFOLD_TEST_CGROUP: workloads },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
try {
  process.exitCode = await child.exited;
} finally {
  clearTimeout(timer);
}
