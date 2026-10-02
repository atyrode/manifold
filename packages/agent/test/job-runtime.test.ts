import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockExclusive } from "../src/job-files.ts";
import type { ServiceCredentialEnrollmentPrepareReply } from "@manifold/protocol";

// Each opening runs in a subprocess so refused startup descriptors and module
// spies cannot leak into another test. Only cgroup recovery is replaced; the
// credential, private listener and filesystem state belong entirely to the fixture.
const openFixture = `
  import { spyOn } from "bun:test";
  import { createPublicKey, randomUUID, verify } from "node:crypto";
  import { readFileSync, readdirSync, readlinkSync } from "node:fs";
  import { canonicalJobJson } from "@manifold/protocol";
  import * as linux from ${JSON.stringify(new URL("../src/job-linux.ts", import.meta.url).href)};
  import { openConfiguredJobOwner } from ${JSON.stringify(new URL("../src/job-runtime.ts", import.meta.url).href)};
  import { listenJobOwner } from ${JSON.stringify(new URL("../src/job-owner-link.ts", import.meta.url).href)};
  spyOn(linux, "recoverLinuxJobs").mockResolvedValue(undefined);
  const [root, uid, mode] = process.argv.slice(1);
  if (uid !== "") process.setuid(Number(uid));
  try {
    const owner = await openConfiguredJobOwner(
      root + "/config/owner.json", root + "/socket/owner.sock", root + "/terminal/host.sock",
    );
    const generation = owner.identity.generation;
    let reply;
    let metadata;
    let detach;
    const firstIdentity = owner.identity;
    if (mode === "prepare" || mode === "metadata") {
      const config = JSON.parse(readFileSync(root + "/config/owner.json", "utf8"));
      const events = [];
      detach = owner.attach(event => { events.push(event); return true; });
      const nonce = randomUUID();
      await owner.execute({
        type: "owner_challenge", nonce, serverEpoch: "fixture-epoch",
        machineId: config.machineId, admissionPublicKey: config.admissionPublicKey,
      });
      if (mode === "prepare") {
        await owner.execute({
          type: "credential_enrollment_prepare", requestId: randomUUID(),
          serverEpoch: "fixture-epoch", ownerChallenge: nonce, machineId: config.machineId,
          credentialRef: "fixture", origin: "https://service.invalid", replace: true,
        });
        reply = events.find(event => event.type === "credential_enrollment_prepared").reply;
      } else {
        const proof = events.find(event => event.type === "owner_proof");
        const body = {
          nonce: proof.nonce, serverEpoch: proof.serverEpoch, machineId: proof.machineId,
          owner: proof.owner,
        };
        const check = owner => verify(null, Buffer.from(canonicalJobJson({ ...body, owner })),
          createPublicKey(firstIdentity.publicKey), Buffer.from(proof.signature, "base64"));
        metadata = {
          proofVerified: check(body.owner),
          alteredKeyRefused: !check({
            ...body.owner, credentialEnrollment: { ...body.owner.credentialEnrollment, keyId: "f".repeat(64) },
          }),
          repeatedIdentityKeyStable:
            canonicalJobJson(firstIdentity.credentialEnrollment) === canonicalJobJson(owner.identity.credentialEnrollment),
        };
      }
      detach();
    }
    const listener = await listenJobOwner(owner, root + "/socket/owner.sock");
    await owner.shutdown();
    listener.stop();
    if (mode === "metadata") {
      const restarted = await openConfiguredJobOwner(
        root + "/config/owner.json", root + "/socket/owner.sock", root + "/terminal/host.sock",
      );
      metadata = {
        ...metadata,
        durableIdentityStable:
          restarted.identity.ownerId === firstIdentity.ownerId && restarted.identity.publicKey === firstIdentity.publicKey,
        generationAdvanced: restarted.identity.generation === firstIdentity.generation + 1,
        recipientRotated: restarted.identity.credentialEnrollment.keyId !== firstIdentity.credentialEnrollment.keyId,
      };
      await restarted.shutdown();
    }
    console.log(JSON.stringify({
      generation,
      ...(mode === "prepare" ? { reply, references: firstIdentity.resources.credentialReferences } : {}),
      ...(mode === "metadata" ? { metadata } : {}),
    }));
  } catch (error) {
    let heldSourceDescriptors;
    if (mode === "unwind") {
      heldSourceDescriptors = 0;
      for (const name of readdirSync("/proc/self/fd")) {
        try {
          if (readlinkSync("/proc/self/fd/" + name).startsWith(root + "/source")) heldSourceDescriptors++;
        } catch {}
      }
    }
    console.log(JSON.stringify({
      error: error.message, code: error.code,
      ...(mode === "unwind" ? { heldSourceDescriptors } : {}),
    }));
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
  hardlinks?: "runtime" | "bubblewrap" | "credential";
  missing?: "leaf" | "parent";
  mode?: "prepare" | "metadata" | "unwind";
  missingBubblewrap?: boolean;
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
    writeFileSync(source, "synthetic-credential", { mode: 0o600 });
    chmodSync(source, options.fileMode ?? 0o600);
    if (options.parentUid !== undefined) chownSync(join(root, "source"), options.parentUid, 0);
    const fileUid = options.fileUid ?? options.runnerUid;
    if (fileUid !== undefined) chownSync(source, fileUid, 0);
    if (options.hardlinks === "credential")
      linkSync(source, join(root, "source", "credential-alias"));
    const original = lstatSync(source);
    let reference = source;
    if (options.missing === "leaf") reference = join(root, "source", "missing");
    if (options.missing === "parent") reference = join(root, "absent", "missing");
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
    if (options.hardlinks === "bubblewrap") linkSync(bubblewrap, join(root, "bubblewrap-alias"));
    const runtimeSource = join(root, "runtime", "value");
    if (options.hardlinks === "runtime") {
      mkdirSync(join(root, "runtime"), { mode: 0o755 });
      writeFileSync(runtimeSource, "immutable-runtime-fixture", { mode: 0o444 });
      linkSync(runtimeSource, join(root, "runtime", "alias"));
    }
    const configPath = join(root, "config", "owner.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        machineId: "credential-source-fixture",
        admissionPublicKey: generateKeyPairSync("ed25519")
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
        stateDirectory: join(root, "state"),
        delegatedCgroup: join(root, "cgroup"),
        bubblewrap: options.missingBubblewrap ? join(root, "absent-bubblewrap") : bubblewrap,
        protectedDirectories: [],
        anchors: {},
        runtimeTools:
          options.hardlinks === "runtime"
            ? { fixture: [{ source: runtimeSource, target: "/runtime/value", kind: "file" }] }
            : {},
        serviceCredentials: {
          fixture: { source: reference, origins: ["https://service.invalid"] },
        },
        artifactOrigins: ["https://artifacts.invalid"],
      }),
      { mode: 0o600 },
    );
    if (options.runnerUid !== undefined) {
      chownSync(configPath, options.runnerUid, 0);
      chownSync(bubblewrap, options.runnerUid, 0);
    }
    chmodSync(join(root, "source"), options.parentMode ?? 0o755);
    const originalParent = lstatSync(join(root, "source"));
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        openFixture,
        root,
        String(options.runnerUid ?? ""),
        options.mode ?? "",
      ],
      {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result: {
      generation?: number;
      error?: string;
      code?: string;
      reply?: ServiceCredentialEnrollmentPrepareReply;
      references?: Array<{ ref: string; origins: string[]; available: boolean }>;
      heldSourceDescriptors?: number;
      metadata?: {
        proofVerified: boolean;
        alteredKeyRefused: boolean;
        repeatedIdentityKeyStable: boolean;
        durableIdentityStable: boolean;
        generationAdvanced: boolean;
        recipientRotated: boolean;
      };
    } = JSON.parse(child.stdout.toString());
    // Opening must retain the original private source, not chmod, copy or relocate it.
    const retainedParent = lstatSync(join(root, "source"));
    expect([
      retainedParent.dev,
      retainedParent.ino,
      retainedParent.mode,
      retainedParent.uid,
    ]).toEqual([originalParent.dev, originalParent.ino, originalParent.mode, originalParent.uid]);
    // Restore only this fixture after checking the owner left its permissions alone.
    chmodSync(join(root, "source"), 0o700);
    const retained = lstatSync(source);
    expect([retained.dev, retained.ino, retained.mode, retained.uid, retained.nlink]).toEqual([
      original.dev,
      original.ino,
      original.mode,
      original.uid,
      original.nlink,
    ]);
    return result;
  } finally {
    chmodSync(join(root, "source"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "linux")("native credential source opening", () => {
  test("accepts a private credential in its existing traversable user-owned parent", () => {
    expect(openCredentialFixture()).toEqual({ generation: 1 });
  });

  test("a held private parent with missing declared leaf remains unavailable but enrollable", () => {
    const result = openCredentialFixture({ missing: "leaf", parentMode: 0o700, mode: "prepare" });
    expect(result.references).toEqual([
      { ref: "fixture", origins: ["https://service.invalid"], available: false },
    ]);
    expect(result.reply).toMatchObject({
      kind: "prepared",
      challenge: { context: { sourceRevision: null, credentialRef: "fixture" } },
    });
  });

  test("a missing declared parent refuses bootstrap rather than creating fallback storage", () => {
    expect(openCredentialFixture({ missing: "parent" })).toMatchObject({ code: "ENOENT" });
  });

  test.each([0o755, 0o500])(
    "mode %o parents retain read access but refuse enrollment",
    (parentMode) => {
      const result = openCredentialFixture({ parentMode, mode: "prepare" });
      expect(result.references).toEqual([
        { ref: "fixture", origins: ["https://service.invalid"], available: true },
      ]);
      expect(result.reply).toEqual({ kind: "refused", reason: "credential_source_read_only" });
    },
  );

  test.skipIf(process.getuid?.() !== 0)(
    "root-managed private parents never gain enrollment authority",
    () => {
      const result = openCredentialFixture({
        runnerUid: 65534,
        parentUid: 0,
        parentMode: 0o755,
        mode: "prepare",
      });
      expect(result.reply).toEqual({ kind: "refused", reason: "credential_source_read_only" });
    },
  );

  test("a later bootstrap failure closes every held source descriptor and parent", () => {
    expect(openCredentialFixture({ missingBubblewrap: true, mode: "unwind" })).toMatchObject({
      code: "ENOENT",
      heldSourceDescriptors: 0,
    });
  });

  test("the signed owner binds immutable recipient metadata, rotating it independently of durable identity", () => {
    expect(openCredentialFixture({ mode: "metadata" }).metadata).toEqual({
      proofVerified: true,
      alteredKeyRefused: true,
      repeatedIdentityKeyStable: true,
      durableIdentityStable: true,
      generationAdvanced: true,
      recipientRotated: true,
    });
  });

  test("opens a private credential without directory-listing authority", () => {
    expect(
      openCredentialFixture({
        parentMode: 0o111,
        ...(process.getuid?.() === 0 ? { runnerUid: 65534, parentUid: 0 } : {}),
      }),
    ).toEqual({ generation: 1 });
  });

  test("still refuses a credential when its directory cannot be searched", () => {
    expect(
      openCredentialFixture({
        parentMode: 0o400,
        ...(process.getuid?.() === 0 ? { runnerUid: 65534, parentUid: 0 } : {}),
      }),
    ).toMatchObject({ code: "EACCES" });
  });

  test.each([0o640, 0o604])("refuses an exposed credential with mode %o", (fileMode) => {
    expect(openCredentialFixture({ fileMode })).toEqual({
      error: "unsafe_service_credential_reference",
    });
  });

  test.each([0o775, 0o757])("refuses a mutable source parent with mode %o", (parentMode) => {
    expect(openCredentialFixture({ parentMode })).toEqual({
      error: "unsafe_service_credential_reference",
    });
  });

  test.each(["file", "parent"] as const)("refuses a symlink %s source", (symlink) => {
    const result = openCredentialFixture({ symlink });
    expect(result.code).toBe(symlink === "file" ? "ELOOP" : "ENOTDIR");
  });

  test.each(["config", "state", "socket", "terminal"] as const)(
    "still requires a private %s directory",
    (exposedDirectory) => {
      expect(openCredentialFixture({ exposedDirectory })).toEqual({
        error: "directory_not_private",
      });
    },
  );

  test("refuses a hard-linked private credential", () => {
    expect(openCredentialFixture({ hardlinks: "credential" })).toEqual({
      error: "unsafe_file_identity",
    });
  });

  test.skipIf(process.getuid?.() !== 0)(
    "accepts a root-managed parent for a non-root owner's private file",
    () => {
      expect(openCredentialFixture({ runnerUid: 65534, parentUid: 0 })).toEqual({ generation: 1 });
    },
  );

  test.skipIf(process.getuid?.() !== 0)(
    "refuses a non-writable parent owned by an unrelated user",
    () => {
      expect(openCredentialFixture({ parentUid: 65534 })).toEqual({
        error: "unsafe_service_credential_reference",
      });
    },
  );

  test.skipIf(process.getuid?.() !== 0)(
    "refuses a private credential owned by another user",
    () => {
      expect(openCredentialFixture({ fileUid: 65534 })).toEqual({
        error: "unsafe_service_credential_reference",
      });
    },
  );
});

describe.skipIf(process.platform !== "linux")("native runtime source opening", () => {
  test.each(["runtime", "bubblewrap"] as const)(
    "opens the owner with a hard-linked %s resource",
    (hardlinks) => {
      expect(openCredentialFixture({ hardlinks })).toEqual({ generation: 1 });
    },
  );
});

// One machine's owner configuration and runtime anchor, kept across several owner starts.
function writeScratchConfig(root: string, toolDirectory?: string): void {
  writeFileSync(
    join(root, "config", "owner.json"),
    JSON.stringify({
      machineId: "temporary-output-fixture",
      admissionPublicKey: generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
      stateDirectory: join(root, "state"),
      delegatedCgroup: join(root, "cgroup"),
      bubblewrap: join(root, "bubblewrap"),
      protectedDirectories: [],
      anchors: { runtime: join(root, "runtime") },
      runtimeTools: toolDirectory
        ? { fixture: [{ source: toolDirectory, target: "/runtime/fixture", kind: "directory" }] }
        : {},
      artifactOrigins: ["https://artifacts.invalid"],
    }),
    { mode: 0o600 },
  );
}
function withScratchRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "job-runtime-scratch-"));
  try {
    for (const name of ["config", "state", "socket", "terminal", "cgroup", "runtime"])
      mkdirSync(join(root, name), { mode: 0o700 });
    mkdirSync(join(root, "runtime", "keep"), { mode: 0o700 });
    writeFileSync(join(root, "runtime", "keep", "sentinel"), "kept");
    writeFileSync(join(root, "bubblewrap"), "synthetic-executable", { mode: 0o600 });
    writeScratchConfig(root);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function startOwner(root: string): { generation?: number; error?: string; code?: string } {
  const child = Bun.spawnSync([process.execPath, "-e", openFixture, root, ""], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString());
}
// The namespace the owner's protected state records, checked against the directory it names.
function recordedNamespace(root: string): { name: string; path: string; bytes: string } {
  const bytes = readFileSync(join(root, "state", "output-scratch"), "utf8");
  const record = JSON.parse(bytes) as { name: string; dev: string; ino: string };
  expect(Object.keys(record).sort()).toEqual(["dev", "ino", "name"]);
  expect(record.name).toMatch(/^job-output-scratch-[0-9a-f-]{36}$/);
  const path = join(root, "runtime", record.name);
  const stat = lstatSync(path, { bigint: true });
  expect([record.dev, record.ino]).toEqual([String(stat.dev), String(stat.ino)]);
  expect(Number(stat.mode & 0o777n)).toBe(0o700);
  return { name: record.name, path, bytes };
}
// Every entry beneath a directory with its identity, mode and content; links are not followed.
function tree(path: string, prefix = ""): string[] {
  return readdirSync(path)
    .sort()
    .flatMap((name) => {
      const entry = join(path, name);
      const stat = lstatSync(entry);
      const id = `${prefix}${name}:${stat.ino}:${(stat.mode & 0o777).toString(8)}`;
      if (stat.isDirectory()) return [id, ...tree(entry, `${prefix}${name}/`)];
      if (stat.isSymbolicLink()) return [`${id}->${readlinkSync(entry)}`];
      return [`${id}=${readFileSync(entry, "utf8")}`];
    });
}
// What a location declared before #933 could legally keep at the fixed name, with a link out.
function legacyScratch(root: string): void {
  const legacy = join(root, "runtime", "job-output-scratch");
  mkdirSync(join(legacy, "stale", "tree"), { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy, "stale", "tree", "payload"), "retained output");
  symlinkSync(join(root, "runtime", "keep"), join(legacy, "stale", "escape"));
}

describe.skipIf(process.platform !== "linux")("native temporary output namespace", () => {
  test("a first start records a fresh namespace of its own and never adopts the fixed legacy name", () => {
    withScratchRoot((root) => {
      legacyScratch(root);
      const found = tree(join(root, "runtime"));
      expect(startOwner(root)).toEqual({ generation: 1 });
      const namespace = recordedNamespace(root);
      expect(lstatSync(join(root, "state", "output-scratch")).mode & 0o777).toBe(0o600);
      expect(readdirSync(namespace.path)).toEqual([]);
      // Everything already in runtime storage is exactly as found; the owner only added its own.
      const added = ["job-inputs", namespace.name];
      expect(
        tree(join(root, "runtime")).filter((entry) => !added.includes(entry.split(":")[0]!)),
      ).toEqual(found);
    });
  });

  test("only the recorded namespace is protected; the fixed legacy name is an ordinary source", () => {
    withScratchRoot((root) => {
      legacyScratch(root);
      expect(startOwner(root)).toEqual({ generation: 1 });
      const namespace = recordedNamespace(root);
      writeScratchConfig(root, join(root, "runtime", "job-output-scratch"));
      expect(startOwner(root)).toEqual({ generation: 2 });
      writeScratchConfig(root, namespace.path);
      expect(startOwner(root)).toEqual({ error: "private_owner_source_overlap" });
      expect(recordedNamespace(root).bytes).toBe(namespace.bytes);
      const legacy = join(root, "runtime", "job-output-scratch", "stale", "tree", "payload");
      expect(readFileSync(legacy, "utf8")).toBe("retained output");
    });
  }, 30_000);

  test("a restarted owner reopens its recorded namespace and clears only what it held there", () => {
    withScratchRoot((root) => {
      legacyScratch(root);
      expect(startOwner(root)).toEqual({ generation: 1 });
      const namespace = recordedNamespace(root);
      mkdirSync(join(namespace.path, "stale", "tree"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(namespace.path, "stale", "tree", "payload"),
        "an earlier generation's bytes",
      );
      symlinkSync(join(root, "runtime", "keep"), join(namespace.path, "stale", "escape"));
      const found = tree(join(root, "runtime")).filter(
        (entry) => !entry.startsWith(namespace.name),
      );
      expect(startOwner(root)).toEqual({ generation: 2 });
      expect(recordedNamespace(root).bytes).toBe(namespace.bytes);
      expect(readdirSync(namespace.path)).toEqual([]);
      expect(
        tree(join(root, "runtime")).filter((entry) => !entry.startsWith(namespace.name)),
      ).toEqual(found);
    });
  }, 30_000);

  test("a recorded namespace lost with the runtime tmpfs is replaced by a fresh recorded one", () => {
    withScratchRoot((root) => {
      expect(startOwner(root)).toEqual({ generation: 1 });
      const lost = recordedNamespace(root);
      rmSync(lost.path, { recursive: true });
      expect(startOwner(root)).toEqual({ generation: 2 });
      const fresh = recordedNamespace(root);
      expect(fresh.name).not.toBe(lost.name);
      expect(readdirSync(join(root, "runtime")).sort()).toEqual(
        ["job-inputs", fresh.name, "keep"].sort(),
      );
    });
  }, 30_000);

  test.each([
    [
      "replaced by another directory",
      (root: string, path: string) => {
        mkdirSync(join(root, "runtime", "replacement"), { mode: 0o700 });
        writeFileSync(join(root, "runtime", "replacement", "payload"), "not the owner's");
        renameSync(path, join(root, "runtime", "moved"));
        renameSync(join(root, "runtime", "replacement"), path);
      },
      { error: "output_scratch_changed" },
    ],
    [
      "replaced by a link",
      (root: string, path: string) => {
        renameSync(path, join(root, "runtime", "moved"));
        symlinkSync(join(root, "runtime", "moved"), path);
      },
      { code: "ENOTDIR" },
    ],
    [
      "opened to others",
      (_root: string, path: string) => chmodSync(path, 0o750),
      { error: "output_scratch_not_private" },
    ],
    [
      "recorded under the fixed legacy name",
      (root: string) =>
        writeFileSync(
          join(root, "state", "output-scratch"),
          JSON.stringify({ name: "job-output-scratch", dev: "1", ino: "1" }),
        ),
      { error: "output_scratch_record_invalid" },
    ],
  ] as const)(
    "a namespace %s refuses the start and every byte is left as found",
    (_case, change, refusal) => {
      withScratchRoot((root) => {
        legacyScratch(root);
        expect(startOwner(root)).toEqual({ generation: 1 });
        const namespace = recordedNamespace(root);
        writeFileSync(join(namespace.path, "retained"), "an earlier generation's bytes");
        change(root, namespace.path);
        const record = readFileSync(join(root, "state", "output-scratch"), "utf8");
        const found = tree(join(root, "runtime"));
        expect(startOwner(root)).toMatchObject(refusal);
        expect(readFileSync(join(root, "state", "output-scratch"), "utf8")).toBe(record);
        expect(tree(join(root, "runtime"))).toEqual(found);
      });
    },
    30_000,
  );

  test("a start while another owner holds the lock neither creates nor replaces a record", () => {
    withScratchRoot((root) => {
      const record = join(root, "state", "output-scratch");
      const whileLocked = (check: () => void) => {
        mkdirSync(join(root, "state", "journal"), { recursive: true, mode: 0o700 });
        const fd = openSync(
          join(root, "state", "journal", "owner.lock"),
          constants.O_RDWR | constants.O_CREAT,
          0o600,
        );
        try {
          lockExclusive(fd);
          check();
        } finally {
          closeSync(fd);
        }
      };
      whileLocked(() => {
        expect(startOwner(root)).toEqual({ error: "job_owner_already_locked" });
        expect(existsSync(record)).toBe(false);
        expect(readdirSync(join(root, "runtime"))).toEqual(["keep"]);
      });
      expect(startOwner(root)).toEqual({ generation: 1 });
      const active = recordedNamespace(root);
      // Even a namespace that looks lost is only the lock holder's to replace.
      rmSync(active.path, { recursive: true });
      whileLocked(() => {
        expect(startOwner(root)).toEqual({ error: "job_owner_already_locked" });
        expect(readFileSync(record, "utf8")).toBe(active.bytes);
        expect(readdirSync(join(root, "runtime")).sort()).toEqual(["job-inputs", "keep"]);
      });
    });
  }, 30_000);
});

// Reports what an opened owner advertises and what it logged about each operator anchor.
const anchorFixture = `
  import { spyOn } from "bun:test";
  import * as linux from ${JSON.stringify(new URL("../src/job-linux.ts", import.meta.url).href)};
  import { openConfiguredJobOwner } from ${JSON.stringify(new URL("../src/job-runtime.ts", import.meta.url).href)};
  spyOn(linux, "recoverLinuxJobs").mockResolvedValue(undefined);
  const [root] = process.argv.slice(1);
  const logs = [];
  const owner = await openConfiguredJobOwner(
    root + "/config/owner.json", root + "/socket/owner.sock", root + "/terminal/host.sock",
    (level, evt, fields) => logs.push({ level, evt, ...fields }),
  );
  const { generation, resources } = owner.identity;
  await owner.shutdown();
  console.log(JSON.stringify({ generation, resources, logs }));
`;

type AnchorFixtureResult = {
  generation: number;
  resources: { anchors: Record<string, string>; anchorDefinitions?: Record<string, unknown> };
  logs: { level: string; evt: string; anchor: string; reason: string }[];
};

function openAnchorFixture(views: boolean): AnchorFixtureResult {
  const root = mkdtempSync(join(tmpdir(), "job-runtime-anchor-"));
  const busybox = process.env.MANIFOLD_TEST_STATIC_BUSYBOX!;
  const mounted: string[] = [];
  try {
    for (const name of ["config", "state", "socket", "terminal", "cgroup", "views"])
      mkdirSync(join(root, name), { mode: 0o700 });
    mkdirSync(join(root, "sessions"), { mode: 0o700 });
    writeFileSync(join(root, "sessions", "private.jsonl"), "synthetic", { mode: 0o600 });
    mkdirSync(join(root, "guarded", "secret"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "writable"));
    const operatorAnchors: Record<string, { path: string; source?: string; readOnly: true }> = {
      "operator.writable": { path: join(root, "writable"), readOnly: true },
      "operator.absent": { path: join(root, "absent"), readOnly: true },
    };
    if (views) {
      // The disposable namespace stands in for the native module's root helper.
      for (const [name, source] of [
        ["sessions", join(root, "sessions")],
        ["guarded", join(root, "guarded")],
      ] as const) {
        const view = join(root, "views", name);
        mkdirSync(view);
        for (const argv of [
          ["mount", "--bind", source, view],
          ["mount", "-o", "remount,bind,ro", view],
        ]) {
          const mount = Bun.spawnSync([busybox, ...argv], { stderr: "pipe" });
          expect(mount.exitCode, mount.stderr.toString()).toBe(0);
          if (argv[1] === "--bind") mounted.push(view);
        }
        operatorAnchors[`operator.${name}`] = { path: view, source, readOnly: true };
      }
    }
    writeFileSync(
      join(root, "config", "owner.json"),
      JSON.stringify({
        machineId: "operator-anchor-fixture",
        admissionPublicKey: generateKeyPairSync("ed25519")
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
        stateDirectory: join(root, "state"),
        delegatedCgroup: join(root, "cgroup"),
        bubblewrap: join(root, "bubblewrap"),
        protectedDirectories: [join(root, "guarded", "secret")],
        anchors: {},
        operatorAnchors,
        runtimeTools: {},
        artifactOrigins: ["https://artifacts.invalid"],
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(root, "bubblewrap"), "synthetic-executable", { mode: 0o600 });
    const child = Bun.spawnSync([process.execPath, "-e", anchorFixture, root], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString());
  } finally {
    for (const view of mounted) Bun.spawnSync([busybox, "umount", view]);
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "linux")("native operator anchor holding", () => {
  test("an anchor that is absent or not a read-only mount is unavailable and the owner still opens", () => {
    const result = openAnchorFixture(false);
    expect(result.generation).toBe(1);
    expect(result.resources.anchors).toEqual({});
    // No anchor was held, so nothing about the host is advertised.
    expect(Object.hasOwn(result.resources, "anchorDefinitions")).toBe(false);
    expect(result.logs).toEqual([
      {
        level: "warn",
        evt: "operator_anchor_unavailable",
        anchor: "operator.writable",
        reason: "operator_anchor_not_read_only",
      },
      {
        level: "warn",
        evt: "operator_anchor_unavailable",
        anchor: "operator.absent",
        reason: "operator_anchor_absent",
      },
    ]);
  });
});

// verify-jobs runs this inside its disposable user and mount namespace, where the fixture
// may create read-only binds; it is never run against the host's own mount table.
const disposableMounts =
  process.platform === "linux" &&
  Boolean(process.env.MANIFOLD_TEST_MOUNT_TREE && process.env.MANIFOLD_TEST_STATIC_BUSYBOX);
test.skipIf(!disposableMounts)(
  "[real-linux] the owner holds a read-only view and advertises its host source, but never one over protected storage",
  () => {
    const result = openAnchorFixture(true);
    expect(result.generation).toBe(1);
    expect(Object.keys(result.resources.anchors)).toEqual(["operator.sessions"]);
    expect(result.resources.anchorDefinitions).toEqual({
      "operator.sessions": { source: expect.stringMatching(/\/sessions$/), readOnly: true },
    });
    expect(result.logs.map(({ anchor, reason }) => [anchor, reason])).toEqual([
      ["operator.writable", "operator_anchor_not_read_only"],
      ["operator.absent", "operator_anchor_absent"],
      ["operator.guarded", "operator_anchor_overlaps_protected"],
    ]);
  },
);
