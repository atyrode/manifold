import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
// Whole files, deliberately: 36 of their 74 cases also run in the gate's unit and e2e
// tasks, seconds out of a fourteen-minute `checks`. They are not redundant here. This
// unit runs them as uid 0 in an unprivileged user namespace, under private mount
// propagation and `env -i`, so a refusal that leans on permission bits or on ambient
// environment fails here and passes in the gate; and the reusable Plugins workflow runs
// verify:jobs without ever running the gate, so downstream plugin repos get no other
// execution of them. Trimming to a `-t` allowlist of the 38 gated cases is the obvious
// idea and the reason this comment exists: bun selects by name, not by predicate, so the
// first renamed or newly added skipIf(!realLinux) case is silently deselected, the run
// still exits 0, and a proof that can execute nowhere else stops executing.
// One process for one fixture set: every case shares the delegated `workloads` tree, the
// 64KiB output tmpfs and real listening ports, so --parallel would race them.
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "packages/agent/src/job-linux.test.ts",
    "packages/agent/test/job-owner.test.ts",
    "packages/agent/test/job-locations.test.ts",
    "packages/agent/test/job-outputs.test.ts",
    "packages/testkit/e2e/jobs.test.ts",
    "packages/testkit/e2e/instance-services.test.ts",
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
