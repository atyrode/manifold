import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitRestoredHistory,
  HEARTBEAT_INTERVAL_MS,
  ReplicaGuardRefusal,
  replicaPosition,
  startHeartbeat,
  TAKEOVER_DEADLINE_MS,
  TAKEOVER_QUIET_MS,
  type TakeoverIO,
} from "./replica-guard.ts";

const WRITER = "0e8c2f4a-6b1d-4c3e-9f5a-7d2b1c0e9a84";
const OTHER = "5f3a9c1e-2d4b-4e6f-8a7c-1b9d3e5f7a20";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.MANIFOLD_REPLICA_TAKEOVER;
});

function fixture(): { root: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), "manifold-replica-set-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data);
  return { root, data };
}

function contents(path: string, value: string): void {
  const database = new Database(path);
  try {
    database.run("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, body TEXT)");
    database.query("INSERT OR REPLACE INTO entries VALUES (1, ?)").run(value);
  } finally {
    database.close();
  }
}

function sealed(data: string, path: string, file: string): string {
  const main = join(data, "manifold.db");
  const database = new Database(main);
  try {
    database.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.query("INSERT INTO meta VALUES ('replica-writer', ?)").run(
      JSON.stringify({
        version: 1,
        epoch: 1,
        id: "11111111-1111-4111-8111-111111111111",
        state: "sealed",
        databases: [
          { path, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") },
        ],
      }),
    );
  } finally {
    database.close();
  }
  return main;
}

async function admit(main: string): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "replica-guard.ts"), "validate-restored", main],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return child.exited;
}

test.each([
  [
    "a malformed takeover setting refuses before any claim",
    "not-a-uuid",
    "replica_takeover_invalid",
  ],
  ["an empty takeover setting is unset", " ", "replica_configuration_invalid"],
  ["an unused valid takeover setting is inert", OTHER, "replica_configuration_invalid"],
])("an authenticated-baseline supervisor start: %s", async (_name, setting, reason) => {
  const { data } = fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "replica-guard.ts"),
      "--config-stdin",
      "--authenticated-baseline",
    ],
    {
      env: { ...process.env, MANIFOLD_DATA_DIR: data, MANIFOLD_REPLICA_TAKEOVER: setting },
      stdin: new Blob([""]),
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(JSON.parse(err.trim()) as unknown).toEqual({
    evt: "hub_replica_boot",
    state: "refused",
    reason,
  });
  // Refused before the supervisor's writer lock, and so before any claim or replica read.
  expect(existsSync(join(data, "manifold.replica-writer"))).toBe(false);
});

test("a current main seal refuses an older auxiliary database instead of admitting a partial recovery", async () => {
  const { data } = fixture();
  const auxiliary = join(data, "plugin.db");
  contents(auxiliary, "checkpoint");
  const earlier = readFileSync(auxiliary);
  contents(auxiliary, "acknowledged later transaction");
  const main = sealed(data, "plugin.db", auxiliary);
  expect(await admit(main)).toBe(0);
  writeFileSync(auxiliary, earlier);
  expect(await admit(main)).toBe(1);
});

test("a seal cannot admit a database outside the restored namespace through a relative path", async () => {
  const { root, data } = fixture();
  const outside = join(root, "outside.db");
  contents(outside, "outside the recovered namespace");
  const main = sealed(data, "../outside.db", outside);
  expect(await admit(main)).toBe(1);
});

test("a matching digest does not authorize a symlinked parent outside the restored namespace", async () => {
  const { root, data } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside);
  const database = join(outside, "plugin.db");
  contents(database, "outside the recovered namespace");
  symlinkSync(outside, join(data, "plugins"), "dir");
  const main = sealed(data, "plugins/plugin.db", database);
  expect(await admit(main)).toBe(1);
});

test("restored file verification has a finite admission deadline", async () => {
  const { data } = fixture();
  const auxiliary = join(data, "plugin.db");
  contents(auxiliary, "current state");
  const main = sealed(data, "plugin.db", auxiliary);
  await admitRestoredHistory(main, observation(main, () => "unused").io);
  const clock = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER);
  try {
    expect(await refusal(admitRestoredHistory(main, observation(main, () => "unused").io))).toBe(
      "replica_freshness_timeout",
    );
  } finally {
    clock.mockRestore();
  }
});

function writer(
  path: string,
  value: { epoch: number; id: string; state: "active" | "sealed" },
  heartbeat?: { epoch: number; id: string },
): void {
  const database = new Database(path);
  try {
    database.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database
      .query("INSERT OR REPLACE INTO meta VALUES ('replica-writer', ?)")
      .run(JSON.stringify({ version: 1, ...value, databases: [] }));
    if (heartbeat !== undefined)
      database
        .query("INSERT OR REPLACE INTO meta VALUES ('replica-writer-heartbeat', ?)")
        .run(JSON.stringify({ version: 1, ...heartbeat, beat: 0 }));
  } finally {
    database.close();
  }
}

function history(heartbeat: "own" | "stale" | "none"): string {
  const main = join(fixture().data, "manifold.db");
  writer(
    main,
    { epoch: 3, id: WRITER, state: "active" },
    heartbeat === "own"
      ? { epoch: 3, id: WRITER }
      : heartbeat === "stale"
        ? { epoch: 2, id: OTHER }
        : undefined,
  );
  return main;
}

interface Observation {
  readonly io: TakeoverIO;
  /** The fake clock, in milliseconds since the first poll. */
  readonly clock: { now: number };
  readonly polls: number[];
  readonly restores: number[];
}

/**
 * Restores take no fake time. A listing takes `listingMs` and, like the real one, fails when it
 * cannot finish by the deadline it is given.
 */
function observation(
  main: string,
  position: (now: number, restores: number) => string,
  onRestore?: () => void,
  listingMs = 0,
): Observation {
  const clock = { now: 0 };
  const polls: number[] = [];
  const restores: number[] = [];
  return {
    clock,
    polls,
    restores,
    io: {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
      position: async (deadline) => {
        const started = clock.now;
        polls.push(started);
        clock.now += listingMs;
        if (clock.now > deadline) throw new Error("listing killed at its deadline");
        return position(started, restores.length);
      },
      restore: async () => {
        restores.push(clock.now);
        onRestore?.();
        return main;
      },
    },
  };
}

async function refusal(admission: Promise<unknown>): Promise<string> {
  try {
    await admission;
  } catch (error) {
    if (error instanceof ReplicaGuardRefusal) return error.reason;
    throw error;
  }
  throw new Error("admitted");
}

async function events<T>(run: () => Promise<T>): Promise<Array<Record<string, unknown>>> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await run();
    return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    log.mockRestore();
  }
}

test("a quiet heartbeat-bearing writer is taken over from a restore after the quiet window", async () => {
  const main = history("own");
  const observed = observation(main, () => '["7"]');
  const logged = await events(() => admitRestoredHistory(main, observed.io));
  expect(observed.restores).toEqual([TAKEOVER_QUIET_MS]);
  expect(logged.at(-1)).toEqual({
    evt: "hub_replica_boot",
    state: "replica_takeover",
    epoch: 3,
    legacy: false,
    quietMs: TAKEOVER_QUIET_MS,
  });
});

test("a replica that keeps advancing refuses at the deadline without adopting it", async () => {
  const main = history("own");
  const observed = observation(main, (now) => `["${now}"]`, undefined, 500);
  expect(await refusal(admitRestoredHistory(main, observed.io))).toBe("replica_writer_active");
  expect(observed.clock.now).toBeGreaterThanOrEqual(TAKEOVER_DEADLINE_MS);
  expect(observed.clock.now).toBeLessThanOrEqual(TAKEOVER_DEADLINE_MS + 2_500);
  expect(observed.restores).toEqual([]);
});

test("a replica change inside the window restarts the quiet period", async () => {
  const main = history("own");
  const observed = observation(main, (now) => (now < 20_000 ? '["7"]' : '["8"]'));
  await admitRestoredHistory(main, observed.io);
  expect(observed.restores).toEqual([20_000 + TAKEOVER_QUIET_MS]);
});

test("a write that lands during the final restore is observed again, not admitted", async () => {
  const main = history("own");
  const observed = observation(main, (_now, restores) => (restores === 0 ? '["7"]' : '["8"]'));
  await admitRestoredHistory(main, observed.io);
  expect(observed.restores).toEqual([TAKEOVER_QUIET_MS, 2 * TAKEOVER_QUIET_MS]);
});

test("quiet that begins too late refuses at the deadline", async () => {
  const main = history("own");
  const quietFrom = TAKEOVER_DEADLINE_MS - TAKEOVER_QUIET_MS + 2_000;
  const observed = observation(main, (now) => (now < quietFrom ? `["${now}"]` : '["done"]'));
  expect(await refusal(admitRestoredHistory(main, observed.io))).toBe("replica_writer_active");
  expect(observed.restores).toEqual([]);
});

test.each([
  ["another claim", { epoch: 4, id: OTHER, state: "active" }],
  ["the same claim sealed", { epoch: 3, id: WRITER, state: "sealed" }],
] as const)("a final restore naming %s refuses", async (_name, replacement) => {
  const main = history("own");
  const observed = observation(
    main,
    () => '["7"]',
    () => writer(main, replacement),
  );
  expect(await refusal(admitRestoredHistory(main, observed.io))).toBe("replica_writer_changed");
});

test("a failed replica poll refuses as unavailable", async () => {
  const main = history("own");
  const observed = observation(main, (now) => {
    if (now >= 4_000) throw new Error("listing failed");
    return '["7"]';
  });
  expect(await refusal(admitRestoredHistory(main, observed.io))).toBe("replica_unavailable");
  expect(observed.restores).toEqual([]);

  const hung = observation(main, () => '["7"]', undefined, TAKEOVER_DEADLINE_MS + 1);
  expect(await refusal(admitRestoredHistory(main, hung.io))).toBe("replica_unavailable");
  expect(hung.polls).toEqual([0]);
});

test.each([
  ["no setting", undefined, "none"],
  ["an empty setting", "  ", "none"],
  ["another writer's setting", OTHER, "none"],
  ["a previous claim's heartbeat", undefined, "stale"],
] as const)("a legacy writer with %s refuses at once", async (_name, setting, heartbeat) => {
  if (setting !== undefined) process.env.MANIFOLD_REPLICA_TAKEOVER = setting;
  const main = history(heartbeat);
  const observed = observation(main, () => '["7"]');
  expect(await refusal(admitRestoredHistory(main, observed.io))).toBe("replica_writer_unsealed");
  expect(observed.polls).toEqual([]);
});

test("a legacy writer named by the setting is taken over after the quiet window", async () => {
  process.env.MANIFOLD_REPLICA_TAKEOVER = ` ${WRITER}\n`;
  const main = history("none");
  const observed = observation(main, () => '["7"]');
  const logged = await events(() => admitRestoredHistory(main, observed.io));
  expect(observed.restores).toEqual([TAKEOVER_QUIET_MS]);
  expect(logged.map((line) => line.state)).toEqual([
    "replica_takeover_waiting",
    "replica_takeover",
  ]);
  expect(logged.at(-1)).toMatchObject({ legacy: true, epoch: 3 });
});

test.each([["not-a-uuid"], [WRITER.toUpperCase()], [`${WRITER}0`]])(
  "a malformed setting (%s) refuses before any history is admitted",
  async (setting) => {
    process.env.MANIFOLD_REPLICA_TAKEOVER = setting;
    const { data } = fixture();
    const sealedMain = join(data, "manifold.db");
    writer(sealedMain, { epoch: 3, id: WRITER, state: "sealed" });
    for (const main of [history("none"), history("own"), sealedMain]) {
      const observed = observation(main, () => '["7"]');
      expect(await refusal(admitRestoredHistory(main, observed.io))).toBe(
        "replica_takeover_invalid",
      );
      expect(observed.polls).toEqual([]);
    }
  },
);

test("sealed history is admitted at once, and a well-formed setting it does not need is inert", async () => {
  const main = join(fixture().data, "manifold.db");
  writer(main, { epoch: 3, id: WRITER, state: "sealed" });
  const quiet = observation(main, () => '["7"]');
  expect(await events(() => admitRestoredHistory(main, quiet.io))).toEqual([]);
  expect(quiet.polls).toEqual([]);

  process.env.MANIFOLD_REPLICA_TAKEOVER = OTHER;
  const unused = observation(main, () => '["7"]');
  expect(await events(() => admitRestoredHistory(main, unused.io))).toEqual([
    { evt: "hub_replica_boot", state: "replica_takeover_setting_unused" },
  ]);
  expect(unused.polls).toEqual([]);

  const beating = history("own");
  const observed = observation(beating, () => '["7"]');
  const logged = await events(() => admitRestoredHistory(beating, observed.io));
  expect(logged[0]).toEqual({ evt: "hub_replica_boot", state: "replica_takeover_setting_unused" });
  expect(logged.at(-1)).toMatchObject({ state: "replica_takeover", legacy: false });
});

function beat(path: string): unknown {
  const database = new Database(path, { readonly: true });
  try {
    const row = database
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'replica-writer-heartbeat'")
      .get();
    return row === null ? null : JSON.parse(row.value);
  } finally {
    database.close();
  }
}

test("the heartbeat advances its own claim every interval until stopped", () => {
  vi.useFakeTimers();
  const main = history("own");
  let lost = 0;
  const heartbeat = startHeartbeat(main, { epoch: 3, id: WRITER }, () => (lost += 1));
  try {
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(beat(main)).toEqual({ version: 1, epoch: 3, id: WRITER, beat: 0 });
    vi.advanceTimersByTime(1 + 2 * HEARTBEAT_INTERVAL_MS);
    expect(beat(main)).toEqual({ version: 1, epoch: 3, id: WRITER, beat: 3 });
  } finally {
    heartbeat.stop();
  }
  vi.advanceTimersByTime(2 * HEARTBEAT_INTERVAL_MS);
  expect({ lost, heartbeat: beat(main) }).toEqual({
    lost: 0,
    heartbeat: { version: 1, epoch: 3, id: WRITER, beat: 3 },
  });
});

test("a failed beat is logged without detail and retried on the next tick", () => {
  vi.useFakeTimers();
  const main = history("own");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const heartbeat = startHeartbeat(main, { epoch: 3, id: WRITER }, () => {});
  const database = new Database(main);
  try {
    database.run("ALTER TABLE meta RENAME TO hidden");
    vi.advanceTimersByTime(2 * HEARTBEAT_INTERVAL_MS);
    database.run("ALTER TABLE hidden RENAME TO meta");
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const failed = { evt: "hub_replica_heartbeat", state: "failed" };
    expect({
      logged: log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown),
      heartbeat: beat(main),
    }).toEqual({
      logged: [failed, failed],
      heartbeat: { version: 1, epoch: 3, id: WRITER, beat: 1 },
    });
  } finally {
    heartbeat.stop();
    database.close();
    log.mockRestore();
  }
});

test.each([
  ["another claim", { epoch: 4, id: OTHER, state: "active" }],
  ["the same claim sealed", { epoch: 3, id: WRITER, state: "sealed" }],
] as const)("a record naming %s stops the heartbeat and reports it once", (_name, replacement) => {
  vi.useFakeTimers();
  const main = history("own");
  let lost = 0;
  const heartbeat = startHeartbeat(main, { epoch: 3, id: WRITER }, () => (lost += 1));
  try {
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    writer(main, replacement);
    vi.advanceTimersByTime(3 * HEARTBEAT_INTERVAL_MS);
    expect({ lost, heartbeat: beat(main) }).toEqual({
      lost: 1,
      heartbeat: { version: 1, epoch: 3, id: WRITER, beat: 1 },
    });
  } finally {
    heartbeat.stop();
  }
});

test("the replica position is each database's highest TXID at any level, seen with the current environment", async () => {
  const { root } = fixture();
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  // Litestream 0.5.16 `ltx -level all -json` output: compaction keeps the highest TXID.
  const listing = JSON.stringify([
    { level: 0, min_txid: "000000000000000a", max_txid: "000000000000000a", size: 191 },
    { level: 1, min_txid: "0000000000000002", max_txid: "000000000000000b", size: 228 },
    { level: 9, min_txid: "0000000000000001", max_txid: "0000000000000001", size: 576 },
  ]);
  writeFileSync(
    join(bin, "litestream"),
    `#!/bin/sh
printf '%s|%s|%s\\n' "$MANIFOLD_REPLICA_PATH" "$*" "$(cat)" >> '${calls}'
case "$7" in
  */manifold.db) printf '%s' '${listing}' ;;
  */plugin.db) printf '[]' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  const saved = { path: process.env.PATH, replica: process.env.MANIFOLD_REPLICA_PATH };
  // The guard assigns its default replica path at runtime; children must still expand it.
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.MANIFOLD_REPLICA_PATH = "runtime/manifold.db";
  try {
    const deadline = Date.now() + 60_000;
    expect(await replicaPosition(["/d/manifold.db", "/d/plugin.db"], "dbs: []", deadline)).toBe(
      '["b","0"]',
    );
    expect(readFileSync(calls, "utf8")).toBe(
      [
        "runtime/manifold.db|ltx -config /dev/stdin -level all -json /d/manifold.db|dbs: []",
        "runtime/manifold.db|ltx -config /dev/stdin -level all -json /d/plugin.db|dbs: []",
        "",
      ].join("\n"),
    );
    expect(await refusal(replicaPosition(["/d/other.db"], "dbs: []", deadline))).toBe(
      "replica_unavailable",
    );
  } finally {
    process.env.PATH = saved.path;
    if (saved.replica === undefined) delete process.env.MANIFOLD_REPLICA_PATH;
    else process.env.MANIFOLD_REPLICA_PATH = saved.replica;
  }
});
