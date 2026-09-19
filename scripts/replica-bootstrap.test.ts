import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
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
  readonly env: Record<string, string>;
  run(command: "acknowledge" | "prepare", overrides?: Record<string, string>): Promise<Result>;
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
    env,
    async run(command, overrides = {}) {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "replica-bootstrap.ts"), command],
        {
          env: { ...process.env, ...env, ...overrides },
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

test("unusable local history is refused in place rather than overwritten", async () => {
  const scenarios: Array<readonly [string, (path: string) => void]> = [
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

  for (const [name, arrange] of scenarios) {
    const h = harness(`local-${name}`);
    writeHistory(h.fixture, "replacement must not publish");
    const path = database(h.data);
    arrange(path);
    const before = readFileSync(path);

    const result = await h.run("prepare", { LITESTREAM_TEST_RESULT: "restore" });
    expectRefusal(result);
    expect(readFileSync(path)).toEqual(before);
  }
});
