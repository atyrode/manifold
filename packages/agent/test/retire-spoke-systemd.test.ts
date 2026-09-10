import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Explicit opt-in only: builds public disposable code and starts uniquely named,
// time-limited user services. Never selects an incumbent or reads credentials.
const enabled = process.env.MANIFOLD_RETIREMENT_SYSTEMD_FIXTURE === "1";
const repo = resolve(import.meta.dir, "../../..");

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
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
  if (getenv("FIXTURE_CHILD")) {
    pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) for (;;) pause();
  }
  if (sd_notify(0, "READY=1") <= 0) return 1;
  for (;;) pause();
}
`;

test.skipIf(!enabled)("immutable transport proof rejects owner arguments, substituted executables and hidden child processes", async () => {
  const expression = `let
    flake = builtins.getFlake ${JSON.stringify(repo)};
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in pkgs.runCommandCC "manifold-agent-retirement-fixture" {
    source = ${JSON.stringify(source)};
    passAsFile = [ "source" ];
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [ pkgs.systemd ];
  } ''
    mkdir -p "$out/libexec"
    $CC -x c "$sourcePath" -o "$out/libexec/manifold-agent" $(pkg-config --cflags --libs libsystemd)
    cp "$out/libexec/manifold-agent" "$out/libexec/other-process"
  ''`;
  const transportPackage = await checked([
    "nix", "build", "--impure", "--no-link", "--print-out-paths", "--expr", expression,
  ]);
  expect(transportPackage).toMatch(/^\/nix\/store\/[a-z0-9]{32}-manifold-agent-retirement-fixture$/u);
  for (const scenario of ["transport", "owner-mode", "other-executable", "hidden-child"] as const) {
    const unit = `manifold-retirement-fixture-${crypto.randomUUID()}.service`;
    try {
      await checked([
        "systemd-run", "--user", `--unit=${unit}`, "--collect",
        "--property=Type=notify", "--property=Restart=no", "--property=RuntimeMaxSec=60", "--property=TimeoutStartSec=10",
        ...(scenario === "hidden-child" ? ["--setenv=FIXTURE_CHILD=1"] : []),
        `${transportPackage}/libexec/${scenario === "other-executable" ? "other-process" : "manifold-agent"}`,
        ...(scenario === "owner-mode" ? ["--terminal-host"] : []),
      ]);
      const pid = await checked(["systemctl", "--user", "show", unit, "--property=MainPID", "--value"]);
      const cgroup = await checked(["systemctl", "--user", "show", unit, "--property=ControlGroup", "--value"]);
      expect(pid).toMatch(/^[1-9][0-9]*$/u);
      expect(cgroup.startsWith("/")).toBe(true);
      if (scenario === "hidden-child") {
        expect(readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").trim().split("\n").length).toBe(2);
      }
      const proof = await command([
        "bash", "-c", 'source "$1"; transport_package=$2; transport_pid=$3; transport_cgroup=$4; prove_transport',
        "retirement-kernel-fixture", `${repo}/infra/previews/retire-spoke.sh`, transportPackage, pid, cgroup,
      ]);
      expect(proof.code).toBe(scenario === "transport" ? 0 : 1);
      // Refusing a role never signals the real process or its child.
      expect(await checked(["systemctl", "--user", "show", unit, "--property=MainPID", "--value"])).toBe(pid);
      expect(await checked(["systemctl", "--user", "show", unit, "--property=ActiveState", "--value"])).toBe("active");
    } finally {
      // This exact UUID service belongs to this fixture and runs only inert code.
      await checked(["systemctl", "--user", "stop", unit]);
    }
  }
}, 180_000);
