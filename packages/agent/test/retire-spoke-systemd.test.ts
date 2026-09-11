import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Explicit opt-in only: builds public disposable code and starts uniquely named,
// time-limited user services. Never selects an incumbent or reads credentials.
const enabled = process.env.MANIFOLD_RETIREMENT_SYSTEMD_FIXTURE === "1";
const repo = resolve(import.meta.dir, "../../..");

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: out.trim(), err };
}
async function checked(args: string[]): Promise<string> {
  const result = await command(args);
  if (result.code !== 0) throw new Error(`fixture command failed: ${args[0]}: ${result.err}`);
  return result.out;
}

// These real processes are deliberately inert. No fake /proc paths, forged
// executable ownership, production test seam, or guessed interpreter role.
const source = `#include <stdlib.h>
#include <unistd.h>
#include <systemd/sd-daemon.h>
int main(void) {
  alarm(60); // Kernel deadline also bounds KillMode=none survivors.
  if (getenv("FIXTURE_CHILD")) {
    pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) { alarm(60); for (;;) pause(); }
  }
  #ifdef FIXTURE_UNAPPROVED
  const char *ready = "READY=1\\nSTATUS=Unapproved fixture";
  #else
  const char *ready = "READY=1";
  #endif
  if (sd_notify(0, ready) <= 0) return 1;
  for (;;) pause();
}
`;

test.skipIf(!enabled)(
  "approved transport bytes allow relocation but reject owner arguments, other programs and hidden children",
  async () => {
    const expression = `let
    flake = builtins.getFlake ${JSON.stringify(`git+file://${repo}`)};
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in pkgs.runCommandCC "manifold-agent-retirement-fixture" {
    source = ${JSON.stringify(source)};
    passAsFile = [ "source" ];
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [ pkgs.systemd ];
  } ''
    mkdir -p "$out/libexec"
    $CC -x c "$sourcePath" -o "$out/libexec/manifold-agent" $(pkg-config --cflags --libs libsystemd)
    $CC -DFIXTURE_UNAPPROVED -x c "$sourcePath" -o "$out/libexec/other-process" $(pkg-config --cflags --libs libsystemd)
  ''`;
    const transportPackage = await checked([
      "nix",
      "build",
      "--impure",
      "--no-link",
      "--print-out-paths",
      "--expr",
      expression,
    ]);
    expect(transportPackage).toMatch(
      /^\/nix\/store\/[a-z0-9]{32}-manifold-agent-retirement-fixture$/u,
    );
    for (const scenario of [
      "transport",
      "retained-copy",
      "owner-mode",
      "other-executable",
      "hidden-child",
      "kill-none",
    ] as const) {
      const unit = `manifold-retirement-fixture-${crypto.randomUUID()}.service`;
      const copyDirectory =
        scenario === "retained-copy"
          ? mkdtempSync(join(tmpdir(), "manifold-retained-copy-"))
          : null;
      let originalPid: string | undefined;
      let originalGroup: string | undefined;
      const failures: unknown[] = [];
      try {
        const executable = copyDirectory
          ? join(copyDirectory, "manifold-agent")
          : `${transportPackage}/libexec/${scenario === "other-executable" ? "other-process" : "manifold-agent"}`;
        if (copyDirectory) copyFileSync(`${transportPackage}/libexec/manifold-agent`, executable);
        await checked([
          "systemd-run",
          "--user",
          `--unit=${unit}`,
          "--collect",
          "--property=Type=notify",
          "--property=Restart=no",
          "--property=RuntimeMaxSec=60",
          "--property=TimeoutStartSec=10",
          ...(scenario === "kill-none" ? ["--property=KillMode=none"] : []),
          ...(scenario === "hidden-child" ? ["--setenv=FIXTURE_CHILD=1"] : []),
          executable,
          ...(scenario === "owner-mode" ? ["--terminal-host"] : []),
        ]);
        const pid = await checked([
          "systemctl",
          "--user",
          "show",
          unit,
          "--property=MainPID",
          "--value",
        ]);
        const cgroup = await checked([
          "systemctl",
          "--user",
          "show",
          unit,
          "--property=ControlGroup",
          "--value",
        ]);
        originalPid = pid;
        originalGroup = `/sys/fs/cgroup${cgroup}`;
        expect(pid).toMatch(/^[1-9][0-9]*$/u);
        expect(cgroup.startsWith("/")).toBe(true);
        if (scenario === "hidden-child") {
          expect(
            readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").trim().split("\n").length,
          ).toBe(2);
        }
        const proof = await command([
          "bash",
          "-c",
          'source "$1"; transport_package=$2; transport_pid=$3; transport_cgroup=$4; prove_transport',
          "retirement-kernel-fixture",
          `${repo}/infra/previews/retire-spoke.sh`,
          transportPackage,
          pid,
          cgroup,
        ]);
        const approved = ["transport", "retained-copy", "kill-none"].includes(scenario);
        expect(proof.code).toBe(approved ? 0 : 1);
        // Refusing a role never signals the real process or its child.
        expect(
          await checked(["systemctl", "--user", "show", unit, "--property=MainPID", "--value"]),
        ).toBe(pid);
        expect(
          await checked(["systemctl", "--user", "show", unit, "--property=ActiveState", "--value"]),
        ).toBe("active");
        if (approved) {
          const policy = await command([
            "bash",
            "-c",
            'source "$1"; transport_unit=$2; require_transport_kill_policy',
            "retirement-kill-policy",
            `${repo}/infra/previews/retire-spoke.sh`,
            unit,
          ]);
          expect(policy.code).toBe(scenario === "kill-none" ? 1 : 0);
          await checked(["systemctl", "--user", "stop", unit]);
          const exited = await command([
            "bash",
            "-c",
            'source "$1"; transport_exited "$2" "$3"',
            "retirement-kernel-exit",
            `${repo}/infra/previews/retire-spoke.sh`,
            pid,
            cgroup,
          ]);
          expect(exited.code).toBe(scenario === "kill-none" ? 1 : 0);
          if (scenario === "kill-none") {
            expect(
              await checked(["systemctl", "--user", "show", unit, "--property=MainPID", "--value"]),
            ).toBe("0");
            expect(readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").trim()).toBe(pid);
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        // This exact UUID service belongs to this fixture and runs only inert code.
        try {
          // KillMode=none can leave a process in an inactive unit. Explicitly kill
          // ONLY this UUID fixture's cgroup; alarm(60) also bounds hard interruption.
          await command([
            "systemctl",
            "--user",
            "kill",
            "--signal=SIGKILL",
            "--kill-whom=all",
            unit,
          ]);
          await command(["systemctl", "--user", "stop", unit]);
          // Real kernel cgroup teardown cannot be advanced by Bun's fake clock.
          const deadline = Date.now() + 10_000;
          while (
            (originalPid && existsSync(`/proc/${originalPid}`)) ||
            (originalGroup &&
              existsSync(originalGroup) &&
              !/^populated 0$/m.test(readFileSync(join(originalGroup, "cgroup.events"), "utf8")))
          ) {
            if (Date.now() >= deadline) {
              failures.push(new Error(`Inert fixture cleanup did not empty ${unit}`));
              break;
            }
            await Bun.sleep(20);
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          if (copyDirectory) rmSync(copyDirectory, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, `Retirement fixture failed: ${scenario}`);
    }
  },
  180_000,
);
