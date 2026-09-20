import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../packages/server/src/index.ts";

const roots: string[] = [];
const acknowledgementName = ".replica-init-once.json";

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

interface Harness {
  readonly data: string;
  readonly fixture: string;
  readonly config: string;
  readonly env: Record<string, string>;
  run(
    command: "acknowledge" | "discard" | "prepare",
    overrides?: Record<string, string>,
  ): Promise<Result>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function harness(name: string): Harness {
  const root = temporary(`manifold-replica-${name}`);
  const data = join(root, "data");
  const bin = join(root, "bin");
  const fixture = join(root, "restored.db");
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "infra"));
  const script = join(root, "scripts/replica-bootstrap.ts");
  const config = join(root, "infra/litestream.yml");
  copyFileSync(join(import.meta.dir, "replica-bootstrap.ts"), script);
  copyFileSync(join(import.meta.dir, "../infra/litestream.yml"), config);
  symlinkSync(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  symlinkSync(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");

  const litestream = join(bin, "litestream");
  writeFileSync(
    litestream,
    `#!/bin/sh
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out=$1
  fi
  shift
done
case "\${LITESTREAM_TEST_RESULT:-empty}" in
  empty) exit 0 ;;
  fail)
    printf '%s\\n' "\${LITESTREAM_SECRET_ACCESS_KEY:-missing-secret}" >&2
    exit 23
    ;;
  restore)
    cp "$LITESTREAM_TEST_FIXTURE" "$out"
    ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(litestream, 0o700);

  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    MANIFOLD_DATA_DIR: data,
    MANIFOLD_REPLICA_BUCKET: "fixture-bucket",
    MANIFOLD_REPLICA_ENDPOINT: "https://replica.invalid",
    LITESTREAM_ACCESS_KEY_ID: "fixture-access",
    LITESTREAM_SECRET_ACCESS_KEY: "fixture-secret-must-not-leak",
    LITESTREAM_TEST_FIXTURE: fixture,
  };

  return {
    data,
    fixture,
    config,
    env,
    async run(command, overrides = {}) {
      const child = Bun.spawn([process.execPath, script, command], {
        env: { ...process.env, ...env, ...overrides },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, out, err };
    },
  };
}

function acknowledgement(data: string): string {
  return join(data, acknowledgementName);
}

function database(data: string): string {
  return join(data, "manifold.db");
}

function writeHistory(path: string, marker: string): void {
  const db = openDatabase(path);
  db.exec("CREATE TABLE bootstrap_proof(value TEXT NOT NULL)");
  db.query("INSERT INTO bootstrap_proof(value) VALUES (?)").run(marker);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function readMarker(path: string): string {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    return db.query<{ value: string }, []>("SELECT value FROM bootstrap_proof").get()!.value;
  } finally {
    db.close();
  }
}

function expireAcknowledgement(path: string): void {
  const document = JSON.parse(readFileSync(path, "utf8")) as {
    readonly version: number;
    readonly target: string;
    expiresAt: number;
  };
  document.expiresAt = 0;
  writeFileSync(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
}

function expectRefusal(result: Result): void {
  expect(result.code).not.toBe(0);
}

test("an empty replica refuses, while explicit intent initializes exactly once", async () => {
  const h = harness("one-time");
  const first = await h.run("prepare");
  expectRefusal(first);
  expect(existsSync(database(h.data))).toBe(false);

  const acknowledged = await h.run("acknowledge");
  expect(acknowledged.code).toBe(0);
  expect(existsSync(acknowledgement(h.data))).toBe(true);
  expect(statSync(acknowledgement(h.data)).mode & 0o777).toBe(0o600);
  expectRefusal(await h.run("acknowledge"));

  const initialized = await h.run("prepare");
  expect(initialized.code).toBe(0);
  expect(existsSync(acknowledgement(h.data))).toBe(false);
  const initializedDb = new Database(database(h.data), { readonly: true, strict: true });
  expect(
    Number(
      initializedDb
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
        .get()!.value,
    ),
  ).toBe(SCHEMA_VERSION);
  initializedDb.close();

  expectRefusal(await h.run("acknowledge"));
  expect(existsSync(acknowledgement(h.data))).toBe(false);

  rmSync(database(h.data));
  const replay = await h.run("prepare");
  expectRefusal(replay);
  expect(existsSync(database(h.data))).toBe(false);
});

test("a failed restore consumes intent without leaking child diagnostics", async () => {
  const h = harness("failed-restore");
  expect((await h.run("acknowledge")).code).toBe(0);

  const failed = await h.run("prepare", { LITESTREAM_TEST_RESULT: "fail" });
  expectRefusal(failed);
  expect(existsSync(acknowledgement(h.data))).toBe(false);
  expect(existsSync(database(h.data))).toBe(false);
  expect(`${failed.out}\n${failed.err}`).not.toContain(h.env.LITESTREAM_SECRET_ACCESS_KEY);

  const laterEmptyReplica = await h.run("prepare");
  expectRefusal(laterEmptyReplica);
  expect(existsSync(database(h.data))).toBe(false);
});

test("restored history wins over initialization even when intent exists", async () => {
  const h = harness("restore-wins");
  writeHistory(h.fixture, "recognizable restored history");
  expect((await h.run("acknowledge")).code).toBe(0);

  const restored = await h.run("prepare", { LITESTREAM_TEST_RESULT: "restore" });
  expect(restored.code).toBe(0);
  expect(existsSync(acknowledgement(h.data))).toBe(false);
  expect(readMarker(database(h.data))).toBe("recognizable restored history");
});

test("malformed, expired, and wrong-target intent cannot authorize initialization", async () => {
  const malformed = harness("malformed-intent");
  writeFileSync(acknowledgement(malformed.data), "not json", { mode: 0o600 });
  expectRefusal(await malformed.run("prepare"));
  expect(existsSync(database(malformed.data))).toBe(false);

  const expired = harness("expired-intent");
  expect((await expired.run("acknowledge")).code).toBe(0);
  expireAcknowledgement(acknowledgement(expired.data));
  expectRefusal(await expired.run("prepare"));
  expect(existsSync(database(expired.data))).toBe(false);

  const wrongTarget = harness("wrong-target-intent");
  expect((await wrongTarget.run("acknowledge")).code).toBe(0);
  expectRefusal(
    await wrongTarget.run("prepare", { MANIFOLD_REPLICA_BUCKET: "different-fixture-bucket" }),
  );
  expect(existsSync(database(wrongTarget.data))).toBe(false);
});

const unusableLocalHistories: Array<readonly [string, (path: string) => void]> = [
  ["empty", (path) => writeFileSync(path, "")],
  ["corrupt", (path) => writeFileSync(path, "not a sqlite database")],
  [
    "foreign",
    (path) => {
      const db = new Database(path, { create: true });
      db.exec("CREATE TABLE unrelated(value TEXT)");
      db.close();
    },
  ],
  [
    "future",
    (path) => {
      const db = openDatabase(path);
      db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION + 1),
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  ],
];

// Each native refusal case keeps its own deadline and fixture teardown.
test.each(unusableLocalHistories)(
  "unusable local history (%s) is refused in place rather than overwritten",
  async (name, arrange) => {
    const h = harness(`local-${name}`);
    writeHistory(h.fixture, "replacement must not publish");
    const path = database(h.data);
    arrange(path);
    const before = readFileSync(path);

    const result = await h.run("prepare", { LITESTREAM_TEST_RESULT: "restore" });
    expectRefusal(result);
    expect(readFileSync(path)).toEqual(before);
  },
);

test("orphan WAL cannot replace validated restored authority", async () => {
  const h = harness("orphan-wal");
  writeHistory(h.fixture, "restored authority");
  const donor = join(temporary("replica-wal-donor"), "manifold.db");
  copyFileSync(h.fixture, donor);
  const donorDb = new Database(donor, { strict: true });
  let wal: Buffer<ArrayBuffer>;
  try {
    donorDb.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    donorDb.query("UPDATE bootstrap_proof SET value = ?").run("stale authority");
    wal = readFileSync(`${donor}-wal`);
  } finally {
    donorDb.close();
  }
  const orphan = `${database(h.data)}-wal`;
  writeFileSync(orphan, wal);

  const result = await h.run("prepare", { LITESTREAM_TEST_RESULT: "restore" });
  expect({
    code: result.code,
    history: existsSync(database(h.data)) ? readMarker(database(h.data)) : null,
  }).toEqual({ code: 1, history: null });
  expect(readFileSync(orphan)).toEqual(wal);
  expectRefusal(await h.run("acknowledge"));
});

test("orphan shared-memory and rollback-journal evidence is preserved", async () => {
  for (const suffix of ["-shm", "-journal"]) {
    const h = harness(`orphan${suffix}`);
    writeHistory(h.fixture, "must not publish");
    const orphan = `${database(h.data)}${suffix}`;
    writeFileSync(orphan, "retained local evidence");
    expectRefusal(await h.run("prepare", { LITESTREAM_TEST_RESULT: "restore" }));
    expect(existsSync(database(h.data))).toBe(false);
    expect(readFileSync(orphan, "utf8")).toBe("retained local evidence");
    expectRefusal(await h.run("acknowledge"));
  }
});

test("discarding expired intent permits a fresh decision but grants no initialization", async () => {
  const h = harness("discard-expired");
  expect((await h.run("acknowledge")).code).toBe(0);
  expireAcknowledgement(acknowledgement(h.data));
  expectRefusal(await h.run("prepare"));
  expectRefusal(await h.run("acknowledge"));

  expect((await h.run("discard")).code).toBe(0);
  expect(existsSync(acknowledgement(h.data))).toBe(false);
  expectRefusal(await h.run("prepare"));
  expect(existsSync(database(h.data))).toBe(false);
  expect((await h.run("acknowledge")).code).toBe(0);
  expect((await h.run("prepare")).code).toBe(0);
});

test("configuration, custom-prefix inputs, and storage identity stay bound", async () => {
  const changedConfig = harness("changed-config");
  expect((await changedConfig.run("acknowledge")).code).toBe(0);
  writeFileSync(
    changedConfig.config,
    readFileSync(changedConfig.config, "utf8").replace(
      "path: manifold.db",
      "path: custom-prefix/manifold.db",
    ),
  );
  expectRefusal(await changedConfig.run("prepare"));
  expect(existsSync(database(changedConfig.data))).toBe(false);

  const changedEnvironment = harness("changed-prefix-environment");
  writeFileSync(
    changedEnvironment.config,
    readFileSync(changedEnvironment.config, "utf8").replace(
      "path: manifold.db",
      "path: ${REPLICA_PREFIX}/manifold.db",
    ),
  );
  expect((await changedEnvironment.run("acknowledge", { REPLICA_PREFIX: "first" })).code).toBe(0);
  expectRefusal(await changedEnvironment.run("prepare", { REPLICA_PREFIX: "second" }));
  expect(existsSync(database(changedEnvironment.data))).toBe(false);

  const changedIdentity = harness("changed-storage-identity");
  expect((await changedIdentity.run("acknowledge")).code).toBe(0);
  expectRefusal(
    await changedIdentity.run("prepare", { LITESTREAM_ACCESS_KEY_ID: "another-storage-identity" }),
  );
  expect(existsSync(database(changedIdentity.data))).toBe(false);
});

test("a valid local restart preserves history without consulting an unavailable replica", async () => {
  const h = harness("valid-local");
  writeHistory(database(h.data), "retained local authority");
  const before = readFileSync(database(h.data));
  const result = await h.run("prepare", { LITESTREAM_TEST_RESULT: "fail" });
  expect(result.code).toBe(0);
  expect(readMarker(database(h.data))).toBe("retained local authority");
  expect(readFileSync(database(h.data))).toEqual(before);
});
