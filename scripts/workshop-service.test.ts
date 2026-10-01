import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

if (process.platform !== "linux") {
  console.error(
    "UNVERIFIED: generated workshop user-unit admission requires the Linux systemd parser",
  );
}

test.skipIf(process.platform !== "linux")(
  "the persistent workshop admits an absolute checkout path containing spaces",
  () => {
    const analyze = Bun.which("systemd-analyze");
    if (analyze === null)
      throw new Error("The generated workshop unit needs systemd-analyze verification");
    const directory = mkdtempSync(join(tmpdir(), "manifold-workshop-unit-"));
    try {
      const home = join(directory, "home");
      const bin = join(directory, "bin");
      const checkout = join(directory, "checkout with spaces");
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(bin);
      symlinkSync(root, checkout, "dir");
      symlinkSync(process.execPath, join(bin, "bun"));
      // Only service-manager effects are isolated; the generated unit is admitted by systemd itself.
      writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const config = join(directory, "workshop.json");
      writeFileSync(
        config,
        JSON.stringify({
          manifoldRoot: checkout,
          sourceRoot: root,
          hubUrl: "http://127.0.0.1:7912",
          frontendPort: 7913,
          publicHost: "preview.manifold.tyrode.dev",
          deliver: "docker:manifold-dev-manifold-1",
        }),
      );
      const env = {
        ...process.env,
        HOME: home,
        PREVIEW_HOME: join(directory, "preview"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCKER_HOST: "unix:///run/workshop-unit-test.sock",
        XDG_RUNTIME_DIR: home,
      };
      const generated = Bun.spawnSync(
        ["bash", join(root, "infra/previews/workshop.sh"), "start", config],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
      const unit = join(home, ".config/systemd/user/manifold-code-workshop.service");
      const admitted = Bun.spawnSync([analyze, "--user", "verify", unit], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(admitted.exitCode, admitted.stderr.toString()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
