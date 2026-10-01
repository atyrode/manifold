import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const WRITER = "0e8c2f4a-6b1d-4c3e-9f5a-7d2b1c0e9a84";
const OTHER = "5f3a9c1e-2d4b-4e6f-8a7c-1b9d3e5f7a20";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Call {
  readonly command: string;
  readonly pid: number;
  readonly output?: string;
  readonly mode?: number;
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

interface Terminal {
  readonly evt: "hub_replica_observation";
  readonly state: "admitted" | "refused";
  readonly targetSha256?: string;
  readonly reason?: string;
}

interface Harness {
  readonly data: string;
  readonly remote: string;
  readonly staging: string;
  readonly calls: string;
  readonly config: string;
  launch(overrides?: Record<string, string>): {
    readonly child: Bun.Subprocess;
    readonly result: Promise<Result>;
  };
}

function harness(auxiliary = false): Harness {
  const root = mkdtempSync(join(tmpdir(), "manifold-observer-test-"));
  roots.push(root);
  const data = join(root, "data");
  const remote = join(root, "remote");
  const bin = join(root, "bin");
  const staging = join(root, "tmp");
  const calls = join(root, "calls.jsonl");
  const config = join(root, "litestream.yml");
  for (const path of [data, remote, bin, staging]) mkdirSync(path);
  writeFileSync(join(data, "sentinel"), "unrelated retained local history");
  writeFileSync(
    config,
    JSON.stringify({
      dbs: ["manifold.db", ...(auxiliary ? ["plugins/plugin.db"] : [])].map((name) => ({
        path: `\${MANIFOLD_DATA_DIR}/${name}`,
        replicas: [
          { type: "file", path: `\${OBSERVER_TEST_REMOTE}/\${MANIFOLD_REPLICA_PATH}/${name}` },
        ],
      })),
    }),
  );
  // The process boundary is substituted, not admission: every restored claim and auxiliary
  // fingerprint is read by the actual CLI from real SQLite files. Production/disposable proof
  // uses real Litestream instead of this deterministic failure/interrupt fixture.
  writeFileSync(
    join(bin, "litestream"),
    `#!${process.execPath}
import { copyFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
const args = process.argv.slice(2);
await Bun.stdin.text();
const db = args.at(-1);
const output = args.includes("-o") ? args[args.indexOf("-o") + 1] : undefined;
appendFileSync(process.env.OBSERVER_TEST_CALLS, JSON.stringify({
  command: args[0], pid: process.pid, output,
  mode: output === undefined ? undefined : statSync(dirname(output)).mode & 0o777,
}) + "\\n");
if (process.env.OBSERVER_TEST_MODE === "fail") {
  console.error(process.env.LITESTREAM_SECRET_ACCESS_KEY);
  process.exit(23);
}
if (process.env.OBSERVER_TEST_MODE === "hang") {
  // Deliberately hold a real subprocess open: parent fake timers cannot exercise OS signals.
  setInterval(() => {}, 1000);
  await Promise.withResolvers().promise;
}
if (args[0] === "restore") {
  const source = join(process.env.OBSERVER_TEST_REMOTE, relative(process.env.MANIFOLD_DATA_DIR, db));
  if (existsSync(source)) copyFileSync(source, output);
} else if (args[0] === "ltx") {
  console.log(JSON.stringify([{ max_txid: "0000000000000001" }]));
} else {
  // Any accidental writer/start/reset path is a hard consumer failure.
  process.exit(64);
}
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    TMPDIR: staging,
    MANIFOLD_DATA_DIR: data,
    MANIFOLD_REPLICA_PATH: "run-owned-history",
    MANIFOLD_RECOVERY_LITESTREAM_CONFIG: config,
    MANIFOLD_REPLICA_TAKEOVER: "",
    OBSERVER_TEST_REMOTE: remote,
    OBSERVER_TEST_CALLS: calls,
    LITESTREAM_SECRET_ACCESS_KEY: "observer-secret-must-not-leak",
  };
  return {
    data,
    remote,
    staging,
    calls,
    config,
    launch(overrides: Record<string, string> = {}) {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "replica-guard.ts"), "observe"],
        {
          env: { ...env, ...overrides },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const result = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then(([code, out, err]): Result => ({ code, out, err }));
      return { child, result };
    },
  };
}

function history(path: string, state?: "active" | "sealed", databases: unknown[] = []): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    database.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.run("CREATE TABLE entries (body TEXT NOT NULL)");
    database.run("INSERT INTO entries VALUES ('replicated, not retained-local')");
    database.run("INSERT INTO meta VALUES ('schema_version', '1')");
    if (state !== undefined)
      database
        .query("INSERT INTO meta VALUES ('replica-writer', ?)")
        .run(JSON.stringify({ version: 1, epoch: 3, id: WRITER, state, databases }));
  } finally {
    database.close();
  }
}

function terminal(result: Result): Terminal {
  const lines = `${result.out}\n${result.err}`.trim().split("\n").filter(Boolean);
  const value = lines
    .map((line) => JSON.parse(line) as Terminal)
    .findLast((line) => line.state === "admitted" || line.state === "refused");
  if (value === undefined) throw new Error("observer did not return a terminal result");
  return value;
}

function checkCustody(run: Harness, result: Result): void {
  expect(readdirSync(run.staging)).toEqual([]);
  expect(readdirSync(run.data)).toEqual(["sentinel"]);
  expect(readFileSync(join(run.data, "sentinel"), "utf8")).toBe("unrelated retained local history");
  for (const secret of ["observer-secret-must-not-leak", run.remote, run.data, run.config]) {
    expect(result.out).not.toContain(secret);
    expect(result.err).not.toContain(secret);
  }
}

test("sealed observation admits remote history without publishing local serving state or changing it", async () => {
  const run = harness();
  const source = join(run.remote, "manifold.db");
  history(source, "sealed");
  const before = readFileSync(source);
  const result = await run.launch().result;
  expect(result.code).toBe(0);
  expect(terminal(result)).toEqual({
    evt: "hub_replica_observation",
    state: "admitted",
    targetSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(readFileSync(source)).toEqual(before);
  const selected = await run.launch({ MANIFOLD_REPLICA_PATH: "another-owned-history" }).result;
  expect(terminal(selected).targetSha256).not.toBe(terminal(result).targetSha256);
  checkCustody(run, result);
  checkCustody(run, selected);
});

test.each(["absent", "untracked"] as const)(
  "%s history refuses without initialization",
  async (kind) => {
    const run = harness();
    if (kind === "untracked") history(join(run.remote, "manifold.db"));
    const result = await run.launch().result;
    expect(result.code).toBe(1);
    expect(terminal(result).reason).toBe("replica_freshness_unestablished");
    checkCustody(run, result);
  },
);

test.each(["", OTHER])(
  "legacy unsealed history retains the exact writer authorization requirement",
  async (setting) => {
    const run = harness();
    const source = join(run.remote, "manifold.db");
    history(source, "active");
    const before = readFileSync(source);
    const result = await run.launch({ MANIFOLD_REPLICA_TAKEOVER: setting }).result;
    expect(result.code).toBe(1);
    expect(terminal(result).reason).toBe("replica_writer_unsealed");
    expect(readFileSync(source)).toEqual(before);
    checkCustody(run, result);
  },
);

test.each(["matching", "older", "absent", "unconfigured"] as const)(
  "a %s auxiliary set preserves sealed complete-set admission",
  async (kind) => {
    const run = harness(kind !== "unconfigured");
    const auxiliary = join(run.remote, "plugins/plugin.db");
    history(auxiliary);
    const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(auxiliary)).digest("hex");
    history(join(run.remote, "manifold.db"), "sealed", [{ path: "plugins/plugin.db", sha256 }]);
    if (kind === "older") {
      const database = new Database(auxiliary);
      database.run("UPDATE entries SET body = 'different replica generation'");
      database.close();
    } else if (kind === "absent") rmSync(auxiliary);
    const result = await run.launch().result;
    expect(result.code).toBe(kind === "matching" ? 0 : 1);
    expect(terminal(result).state).toBe(kind === "matching" ? "admitted" : "refused");
    if (kind !== "matching")
      expect(terminal(result).reason).toBe("replica_database_set_incomplete");
    checkCustody(run, result);
  },
);

test("child failure is secret-free and cleans the private restore", async () => {
  const run = harness();
  const result = await run.launch({ OBSERVER_TEST_MODE: "fail" }).result;
  expect(result.code).toBe(1);
  expect(terminal(result).reason).toBe("replica_unavailable");
  checkCustody(run, result);
});

test("a configuration exec directive is refused without starting its command", async () => {
  const run = harness();
  const marker = join(run.data, "must-not-exist");
  const value = JSON.parse(readFileSync(run.config, "utf8")) as { dbs: unknown[] };
  writeFileSync(run.config, JSON.stringify({ ...value, exec: `touch ${marker}` }));
  const result = await run.launch().result;
  expect(result.code).toBe(1);
  expect(terminal(result).reason).toBe("replica_configuration_invalid");
  expect(existsSync(marker)).toBe(false);
  checkCustody(run, result);
});

test("interrupting a hung read kills its child and removes only this run's staging", async () => {
  const run = harness();
  const { promise: started, resolve: wakeStarted } = Promise.withResolvers<void>();
  const watcher = watch(dirname(run.calls), (_event, filename) => {
    if (filename === "calls.jsonl") wakeStarted();
  });
  const launched = run.launch({ OBSERVER_TEST_MODE: "hang" });
  try {
    await Promise.race([
      started,
      launched.result.then(() => {
        throw new Error("observer exited before starting its restore");
      }),
    ]);
    const call = JSON.parse(readFileSync(run.calls, "utf8").trim()) as Call;
    expect(call.mode).toBe(0o700);
    launched.child.kill("SIGTERM");
    const result = await launched.result;
    expect(result.code).toBe(1);
    expect(terminal(result).reason).toBe("replica_observation_interrupted");
    expect(() => process.kill(call.pid, 0)).toThrow();
    checkCustody(run, result);
  } finally {
    watcher.close();
    if (launched.child.exitCode === null && launched.child.signalCode === null)
      launched.child.kill("SIGKILL");
    await launched.child.exited;
  }
}, 10_000);
