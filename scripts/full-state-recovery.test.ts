import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

async function run(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "full-state-recovery.ts"), ...args],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

test("authenticated full-state checkpoint round-trips and tampering restores nothing", async () => {
  const objects = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "HEAD")
        return objects.has(path)
          ? new Response(null, {
              status: 200,
              headers: { "content-length": String(objects.get(path)!.byteLength) },
            })
          : new Response(null, { status: 404 });
      if (request.method === "PUT") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(path, bytes);
        return new Response(null, {
          status: 200,
          headers: { etag: `"${createHash("md5").update(bytes).digest("hex")}"` },
        });
      }
      if (request.method === "GET") {
        const bytes = objects.get(path);
        return bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(Buffer.from(bytes));
      }
      return new Response(null, { status: 405 });
    },
  });
  servers.push(server);

  const source = temporary("manifold-recovery-source");
  const database = new Database(join(source, "manifold.db"));
  database.exec("CREATE TABLE proof(value TEXT NOT NULL); INSERT INTO proof VALUES ('retained')");
  database.close();
  writeFileSync(join(source, "preview-identity.key"), "fixture-signing-key", { mode: 0o600 });
  writeFileSync(join(source, "agent.pid"), "999999\n", { mode: 0o600 });

  const common = {
    MANIFOLD_BUILD: "1.2.3",
    MANIFOLD_OWNER_KEY: "a451".repeat(16),
    MANIFOLD_REPLICA_BUCKET: "fixture",
    MANIFOLD_REPLICA_ENDPOINT: `http://127.0.0.1:${String(server.port)}`,
    LITESTREAM_ACCESS_KEY_ID: "fixture-access",
    LITESTREAM_SECRET_ACCESS_KEY: "fixture-secret",
  };
  const captured = await run(["capture", "before-upgrade"], {
    ...common,
    MANIFOLD_DATA_DIR: source,
  });
  if (captured.code !== 0) throw new Error(captured.err);
  const receipt = JSON.parse(captured.out) as {
    readonly checkpointId: string;
    readonly object: string;
    readonly objectSha256: string;
  };
  expect(receipt).toMatchObject({ checkpointId: "before-upgrade" });
  expect(receipt.objectSha256).toMatch(/^[a-f0-9]{64}$/);
  const verified = await run(["verify", receipt.checkpointId, receipt.objectSha256], common);
  if (verified.code !== 0) throw new Error(verified.err);
  expect(JSON.parse(verified.out)).toMatchObject({ sourceBuild: "1.2.3", databases: 1 });
  const wrongBuild = await run(["verify", receipt.checkpointId, receipt.objectSha256], {
    ...common,
    MANIFOLD_BUILD: "1.2.4",
  });
  expect(wrongBuild.code).toBe(1);
  const wrongKeyRoot = temporary("manifold-recovery-wrong-key");
  const wrongKey = await run(["restore", receipt.checkpointId, receipt.objectSha256], {
    ...common,
    MANIFOLD_OWNER_KEY: "b".repeat(64),
    MANIFOLD_DATA_DIR: wrongKeyRoot,
    MANIFOLD_RECOVERY_EXPECTED_BUILD: "1.2.3",
  });
  expect(wrongKey.code).toBe(1);
  expect(wrongKey.err).toContain("checkpoint authentication failed");
  expect(Array.from(new Bun.Glob("*").scanSync(wrongKeyRoot))).toEqual([]);

  const restored = temporary("manifold-recovery-restored");
  const config = join(temporary("manifold-recovery-control"), "litestream.yml");
  const databases = join(dirname(config), "databases");
  const result = await run(["restore", receipt.checkpointId, receipt.objectSha256], {
    ...common,
    MANIFOLD_DATA_DIR: restored,
    MANIFOLD_RECOVERY_EXPECTED_BUILD: "1.2.3",
    MANIFOLD_RECOVERY_LITESTREAM_CONFIG: config,
    MANIFOLD_RECOVERY_DATABASES_FILE: databases,
  });
  if (result.code !== 0) throw new Error(result.err);
  expect(readFileSync(join(restored, "preview-identity.key"), "utf8")).toBe("fixture-signing-key");
  expect(existsSync(join(restored, "agent.pid"))).toBe(false);
  const recovered = new Database(join(restored, "manifold.db"), { readonly: true });
  expect(recovered.query("SELECT value FROM proof").get()).toEqual({ value: "retained" });
  recovered.close();
  expect(readFileSync(databases, "utf8").trim()).toBe(join(restored, "manifold.db"));
  expect(readFileSync(config, "utf8")).toContain("manifold-recovery/before-upgrade/manifold.db");

  const objectPath = `/fixture/${receipt.object}`;
  const tampered = Uint8Array.from(objects.get(objectPath)!);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  objects.set(objectPath, tampered);
  const refusedControl = temporary("manifold-recovery-refused-control");
  const refused = temporary("manifold-recovery-refused");
  const refusal = await run(["restore", receipt.checkpointId, receipt.objectSha256], {
    ...common,
    MANIFOLD_DATA_DIR: refused,
    MANIFOLD_RECOVERY_EXPECTED_BUILD: "1.2.3",
    MANIFOLD_RECOVERY_LITESTREAM_CONFIG: join(refusedControl, "litestream.yml"),
    MANIFOLD_RECOVERY_DATABASES_FILE: join(refusedControl, "databases"),
  });
  expect(refusal.code).toBe(1);
  expect(refusal.err).toContain("checkpoint object sha256 does not match");
  expect(Array.from(new Bun.Glob("*").scanSync(refused))).toEqual([]);
});

test("capture refuses oversized sparse state before reading or uploading it", async () => {
  const root = temporary("manifold-recovery-oversized");
  const path = join(root, "oversized-state");
  writeFileSync(path, "");
  truncateSync(path, 256 * 1024 * 1024 + 1);
  const result = await run(["capture", "oversized"], {
    MANIFOLD_DATA_DIR: root,
    MANIFOLD_BUILD: "1.2.3",
  });
  expect(result.code).toBe(1);
  expect(result.err).toContain("exceeds the remaining checkpoint bound");
  expect(result.out).toBe("");
});
