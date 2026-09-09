import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each opening runs in a subprocess so refused startup descriptors and module
// spies cannot leak into another test. Only cgroup recovery is replaced: no live
// delegation, service, socket or credential is used by these filesystem fixtures.
const openFixture = `
  import { spyOn } from "bun:test";
  import * as linux from ${JSON.stringify(new URL("../src/job-linux.ts", import.meta.url).href)};
  import { openConfiguredJobOwner } from ${JSON.stringify(new URL("../src/job-runtime.ts", import.meta.url).href)};
  spyOn(linux, "recoverLinuxJobs").mockResolvedValue(undefined);
  const [root, uid] = process.argv.slice(1);
  if (uid !== "") process.setuid(Number(uid));
  try {
    const owner = await openConfiguredJobOwner(
      root + "/config/owner.json", root + "/socket/owner.sock", root + "/terminal/host.sock",
    );
    console.log(JSON.stringify({ generation: owner.identity.generation }));
    await owner.shutdown();
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, code: error.code }));
  }
`;

type FixtureOptions = {
  parentMode?: number;
  fileMode?: number;
  parentUid?: number;
  fileUid?: number;
  runnerUid?: number;
  symlink?: "file" | "parent";
  exposedDirectory?: "config" | "state" | "socket" | "terminal";
};

function openCredentialFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "job-runtime-credential-"));
  const source = join(root, "source", "credential");
  try {
    for (const name of ["config", "state", "socket", "terminal", "source", "cgroup"]) {
      mkdirSync(join(root, name), { mode: 0o700 });
      if (options.runnerUid !== undefined) chownSync(join(root, name), options.runnerUid, 0);
    }
    if (options.runnerUid !== undefined) chownSync(root, options.runnerUid, 0);
    chmodSync(join(root, "source"), options.parentMode ?? 0o755);
    writeFileSync(source, "synthetic-credential", { mode: 0o600 });
    chmodSync(source, options.fileMode ?? 0o600);
    if (options.parentUid !== undefined) chownSync(join(root, "source"), options.parentUid, 0);
    const fileUid = options.fileUid ?? options.runnerUid;
    if (fileUid !== undefined) chownSync(source, fileUid, 0);
    const original = lstatSync(source);
    let reference = source;
    if (options.symlink === "file") {
      reference = join(root, "source", "link");
      symlinkSync(source, reference);
    } else if (options.symlink === "parent") {
      symlinkSync(join(root, "source"), join(root, "linked-source"));
      reference = join(root, "linked-source", "credential");
    }
    if (options.exposedDirectory) chmodSync(join(root, options.exposedDirectory), 0o755);
    // Merely opened, never executed: the fixture does not launch a sandbox.
    const bubblewrap = join(root, "bubblewrap");
    writeFileSync(bubblewrap, "synthetic-executable", { mode: 0o600 });
    const configPath = join(root, "config", "owner.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        machineId: "credential-source-fixture",
        admissionPublicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
        stateDirectory: join(root, "state"),
        delegatedCgroup: join(root, "cgroup"),
        bubblewrap,
        protectedDirectories: [],
        anchors: {},
        runtimeTools: {},
        serviceCredentials: { fixture: { source: reference, origins: ["https://service.invalid"] } },
        artifactOrigins: ["https://artifacts.invalid"],
      }),
      { mode: 0o600 },
    );
    if (options.runnerUid !== undefined) {
      chownSync(configPath, options.runnerUid, 0);
      chownSync(bubblewrap, options.runnerUid, 0);
    }
    const child = Bun.spawnSync([process.execPath, "-e", openFixture, root, String(options.runnerUid ?? "")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result: { generation?: number; error?: string; code?: string } = JSON.parse(child.stdout.toString());
    // Opening must retain the original private source, not chmod, copy or relocate it.
    const retained = lstatSync(source);
    expect([retained.dev, retained.ino, retained.mode, retained.uid, retained.nlink]).toEqual([
      original.dev, original.ino, original.mode, original.uid, original.nlink,
    ]);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "linux")("native credential source opening", () => {
  test("accepts a private credential in its existing traversable user-owned parent", () => {
    expect(openCredentialFixture()).toEqual({ generation: 1 });
  });

  test.each([0o640, 0o604])("refuses an exposed credential with mode %o", (fileMode) => {
    expect(openCredentialFixture({ fileMode })).toEqual({ error: "unsafe_service_credential_reference" });
  });

  test.each([0o775, 0o757])("refuses a mutable source parent with mode %o", (parentMode) => {
    expect(openCredentialFixture({ parentMode })).toEqual({ error: "unsafe_service_credential_reference" });
  });

  test.each(["file", "parent"] as const)("refuses a symlink %s source", (symlink) => {
    const result = openCredentialFixture({ symlink });
    expect(result.code).toBe(symlink === "file" ? "ELOOP" : "ENOTDIR");
  });

  test.each(["config", "state", "socket", "terminal"] as const)(
    "still requires a private %s directory",
    (exposedDirectory) => {
      expect(openCredentialFixture({ exposedDirectory })).toEqual({ error: "directory_not_private" });
    },
  );

  test.skipIf(process.getuid?.() !== 0)("accepts a root-managed parent for a non-root owner's private file", () => {
    expect(openCredentialFixture({ runnerUid: 65534, parentUid: 0 })).toEqual({ generation: 1 });
  });

  test.skipIf(process.getuid?.() !== 0)("refuses a non-writable parent owned by an unrelated user", () => {
    expect(openCredentialFixture({ parentUid: 65534 })).toEqual({ error: "unsafe_service_credential_reference" });
  });

  test.skipIf(process.getuid?.() !== 0)("refuses a private credential owned by another user", () => {
    expect(openCredentialFixture({ fileUid: 65534 })).toEqual({ error: "unsafe_service_credential_reference" });
  });
});
