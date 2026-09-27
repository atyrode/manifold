import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDatabase, PluginStorage } from "@manifold/plugin";
import { HARDENED_CONTRACT_VERSION, type LogEvent, type PluginManifest } from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import {
  acquireWriterLock,
  claimWriterEpoch,
  openDatabase,
  sealWriterEpoch,
  WriterFenceError,
  WriterLockTimeoutError,
} from "../src/db.ts";
import type { Logger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import { AUTHORED_DIR, PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { sha256Hex } from "../src/stores.ts";

const OWNER_KEY = "a".repeat(64);
const directories: string[] = [];

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "manifold-writer-fence-"));
  directories.push(created);
  return created;
}

afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true });
});

function writerRecord(dataDir: string): string | null {
  const db = new Database(join(dataDir, "manifold.db"), { readonly: true, strict: true });
  try {
    return (
      db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'writer-epoch'").get()
        ?.value ?? null
    );
  } finally {
    db.close();
  }
}

interface LogLine {
  readonly evt: LogEvent;
  readonly level: "info" | "warn" | "error";
  readonly fields: Readonly<Record<string, unknown>>;
}

function recordingLogger(lines: LogLine[], onLine?: (line: LogLine) => void): Logger {
  const record =
    (level: LogLine["level"]) =>
    (evt: LogEvent, fields: Readonly<Record<string, unknown>> = {}): void => {
      const line = { evt, level, fields };
      lines.push(line);
      onLine?.(line);
    };
  return { info: record("info"), warn: record("warn"), error: record("error") };
}

function hub(
  dataDir: string,
  lines: LogLine[],
  options: {
    readonly onLine?: (line: LogLine) => void;
    readonly port?: number | undefined;
  } = {},
): Promise<RunningServer> {
  return startServer({
    config: loadConfig({
      MANIFOLD_PORT: String(options.port ?? 0),
      MANIFOLD_DATA_DIR: dataDir,
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    }),
    logger: recordingLogger(lines, options.onLine),
    announce: false,
  });
}

/** One owner-authenticated call through the HTTP action door. */
function act(
  server: RunningServer,
  name: string,
  body: string | ReadableStream,
): Promise<Response> {
  return fetch(`${server.publicUrl}/api/actions/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
    body,
  });
}

/** The parsed outcome of an action door call with `input` as its JSON body. */
async function answer(server: RunningServer, name: string, input: unknown): Promise<unknown> {
  return (await act(server, name, JSON.stringify(input))).json();
}

function createContainer(
  server: RunningServer,
  name: string,
  body?: ReadableStream,
): Promise<Response> {
  return act(server, "core.index.createContainer", body ?? JSON.stringify({ name }));
}

async function containerNames(server: RunningServer): Promise<string[]> {
  const outcome = (await (await act(server, "core.index.listContainers", "{}")).json()) as {
    result: { containers: { name: string }[] };
  };
  return outcome.result.containers.map((container) => container.name);
}

test("the writer lock admits one holder across processes and is released by close or death", async () => {
  const dataDir = directory();
  const held = await acquireWriterLock(dataDir, { waitMs: 0 });
  let waits = 0;
  await expect(
    acquireWriterLock(dataDir, { waitMs: 60, onWait: () => (waits += 1) }),
  ).rejects.toBeInstanceOf(WriterLockTimeoutError);
  expect(waits).toBe(1);
  held.release();
  (await acquireWriterLock(dataDir, { waitMs: 0 })).release();

  // Another process holds it until the kernel reaps that process, with nothing left to clean up.
  // The child is a separate Bun process, so the module is named in its script, not imported here.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { acquireWriterLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/db.ts"))});
       await acquireWriterLock(${JSON.stringify(dataDir)}, { waitMs: 0 });
       console.log("held");
       setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    reader.releaseLock();
    await expect(acquireWriterLock(dataDir, { waitMs: 30 })).rejects.toBeInstanceOf(
      WriterLockTimeoutError,
    );
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  (await acquireWriterLock(dataDir, { waitMs: 1_000 })).release();
});

test("each writer claims the next epoch and reads the last writer this history records", () => {
  const path = join(directory(), "manifold.db");
  const first = openDatabase(path);
  expect(claimWriterEpoch(first)).toEqual({ epoch: 1, previous: null });
  sealWriterEpoch(first, 1);
  // The retiring connection refuses every later write, whoever attempts it.
  expect(() =>
    first.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('late', 'x')"),
  ).toThrow();
  first.close();

  const second = openDatabase(path);
  expect(claimWriterEpoch(second)).toEqual({ epoch: 2, previous: { epoch: 1, sealed: true } });
  expect(() => sealWriterEpoch(second, 1)).toThrow(WriterFenceError);
  second.close(); // a writer that dies without sealing

  const third = openDatabase(path);
  expect(claimWriterEpoch(third)).toEqual({ epoch: 3, previous: { epoch: 2, sealed: false } });
  third.exec("UPDATE meta SET value = 'garbage' WHERE key = 'writer-epoch'");
  expect(() => claimWriterEpoch(third)).toThrow(WriterFenceError);
  third.close();
});

test("a successor on the same data directory becomes the writer only after its predecessor seals", async () => {
  const dataDir = directory();
  const firstLines: LogLine[] = [];
  const secondLines: LogLine[] = [];
  const first = await hub(dataDir, firstLines);
  let second: RunningServer | undefined;
  try {
    expect((await createContainer(first, "before handover")).status).toBe(200);
    let secondReady = false;
    const waiting = Promise.withResolvers<void>();
    const starting = hub(dataDir, secondLines, {
      onLine: (line) => {
        if (line.evt === "writer_waiting") waiting.resolve();
      },
    }).then((server) => {
      secondReady = true;
      second = server;
      return server;
    });
    await waiting.promise;
    // The predecessor keeps serving writes while its successor waits, having opened nothing.
    expect((await createContainer(first, "while successor waits")).status).toBe(200);
    expect(secondReady).toBe(false);
    expect(secondLines.map((line) => line.evt)).toEqual(["writer_waiting"]);

    await first.stop();
    const successor = await starting;
    expect(firstLines.find((line) => line.evt === "writer_sealed")?.fields).toMatchObject({
      epoch: 1,
      settled: true,
    });
    expect(secondLines.find((line) => line.evt === "writer_claimed")).toEqual({
      evt: "writer_claimed",
      level: "info",
      fields: { epoch: 2, previousEpoch: 1, previousState: "sealed" },
    });
    expect(await containerNames(successor)).toEqual(
      expect.arrayContaining(["before handover", "while successor waits"]),
    );
  } finally {
    await first.stop();
    await second?.stop();
  }
  expect(writerRecord(dataDir)).toBe("2:sealed");
});

test("a start that cannot bind its port hands the directory straight on, its epoch left active", async () => {
  const dataDir = directory();
  const occupant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  let successor: RunningServer | undefined;
  try {
    await expect(hub(dataDir, [], { port: occupant.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    // It failed as the writer: the epoch it claimed is on record, and was never sealed.
    expect(writerRecord(dataDir)).toBe("1:active");
    // Its lock is already free: no wait, and nothing left for a collector to close.
    (await acquireWriterLock(dataDir, { waitMs: 0 })).release();

    const lines: LogLine[] = [];
    successor = await hub(dataDir, lines);
    expect(lines.find((line) => line.evt === "writer_claimed")).toEqual({
      evt: "writer_claimed",
      level: "warn",
      fields: { epoch: 2, previousEpoch: 1, previousState: "active" },
    });
    expect((await createContainer(successor, "after a failed start")).status).toBe(200);
    expect(await containerNames(successor)).toContain("after a failed start");
  } finally {
    await successor?.stop();
    await occupant.stop(true);
  }
  expect(writerRecord(dataDir)).toBe("2:sealed");
});

test("a start that fails after binding closes its socket before handing the directory on", async () => {
  const dataDir = directory();
  // A file where the unpacked-plugin directory belongs: the authored watch, a start's last
  // step, refuses it once the socket is already bound.
  const authored = join(dataDir, AUTHORED_DIR);
  writeFileSync(authored, "");
  const vacated = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = vacated.port;
  await vacated.stop(true);
  await expect(hub(dataDir, [], { port })).rejects.toMatchObject({ code: "EEXIST" });
  expect(writerRecord(dataDir)).toBe("1:active");
  (await acquireWriterLock(dataDir, { waitMs: 0 })).release();

  rmSync(authored);
  // The successor binds the very port the failed start had bound, on the same directory.
  const successor = await hub(dataDir, [], { port });
  try {
    expect(successor.port).toBe(port);
    expect((await createContainer(successor, "on the same port")).status).toBe(200);
  } finally {
    await successor.stop();
  }
  expect(writerRecord(dataDir)).toBe("2:sealed");
});

test("a quiescing hub refuses new work with a retryable 503 and commits what it admitted", async () => {
  const dataDir = directory();
  const lines: LogLine[] = [];
  const server = await hub(dataDir, lines);
  const url = server.publicUrl;
  const body = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  // An admitted request whose body is still arriving when the stop begins.
  const admitted = createContainer(
    server,
    "",
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('{"name":'));
        await body.promise;
        controller.enqueue(encoder.encode('"admitted before stop"}'));
        controller.close();
      },
    }),
  );
  // Real sockets: nothing in-process signals that the server has taken the request's headers, so
  // give the loopback round trip a moment before the stop closes admission behind it.
  await Bun.sleep(50);
  const stopping = server.stop();
  expect(lines.some((line) => line.evt === "writer_quiescing")).toBe(true);

  // A cross-origin lens must be able to read the refusal: same CORS policy as every door.
  const lens = { origin: "https://lens.invalid" };
  const preflight = await fetch(`${url}/api/actions/core.index.listContainers`, {
    method: "OPTIONS",
    headers: { ...lens, "access-control-request-method": "POST" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  const refused = await fetch(`${url}/api/actions/core.index.listContainers`, {
    method: "POST",
    headers: {
      ...lens,
      authorization: `Bearer ${OWNER_KEY}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("1");
  expect(refused.headers.get("access-control-allow-origin")).toBe("*");
  expect(refused.headers.get("access-control-expose-headers")).toContain("retry-after");
  const upgrade = await fetch(`${url}/ws/session`, { headers: { upgrade: "websocket" } });
  expect(upgrade.status).toBe(503);
  expect((await fetch(`${url}/healthz`)).status).toBe(200);

  body.resolve();
  const acknowledged = await admitted;
  expect(acknowledged.status).toBe(200);
  expect(((await acknowledged.json()) as { ok: boolean }).ok).toBe(true);
  await stopping;
  expect(writerRecord(dataDir)).toBe("1:sealed");

  const successorLines: LogLine[] = [];
  const successor = await hub(dataDir, successorLines);
  try {
    expect(await containerNames(successor)).toContain("admitted before stop");
  } finally {
    await successor.stop();
  }
});

test("work still running at the quiesce deadline is cut off unacknowledged and never committed", async () => {
  const dataDir = directory();
  const lines: LogLine[] = [];
  const server = await hub(dataDir, lines);
  const encoder = new TextEncoder();
  const never = Promise.withResolvers<void>();
  // Admitted, but its body never completes: the handler cannot finish before the deadline.
  const stalled = createContainer(
    server,
    "",
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('{"name":'));
        await never.promise;
      },
    }),
  ).then(
    (response) => response.status,
    () => "cut" as const,
  );
  // Real sockets: give the loopback round trip a moment before the stop closes admission.
  await Bun.sleep(50);
  await server.stop();
  never.resolve();
  expect(await stalled).not.toBe(200);
  expect(lines.find((line) => line.evt === "writer_sealed")?.fields).toMatchObject({
    epoch: 1,
    settled: false,
  });
  expect(writerRecord(dataDir)).toBe("1:sealed");
  const successor = await hub(dataDir, []);
  try {
    expect(await containerNames(successor)).toEqual([]);
  } finally {
    await successor.stop();
  }
});

/*
  PLUGIN WORK THAT OUTLIVES THE DEADLINE (#318), through the real stop and a real successor. An
  in-realm plugin — installed through the install door like any operator's bundle — can hold an
  admitted action or migration suspended past the quiesce deadline, and nothing can cancel its
  promise. The stop waits out the deadline and no longer, revokes that work BEFORE it releases
  the writer lock, and so the old code resumes — at the successor's first instant as the writer,
  and again once the successor has work of its own — into refusals: no answer, row, key, event
  or file of its own reaches the successor, whose doors keep answering from its own data.
*/

const NOTES_ID = "vendor.notes";
/** The realm-global name of the pause point the notes bundle calls; bound by `pausePoint`. */
const PAUSE_KEY = "manifold.test.writer-fence.pause";

/**
 * Drops version `major` of the notes bundle into the uploads box, for the install door. `write`
 * keeps a note in the plugin's own file and in its key-value ref, stages a `wrote` event, then
 * reaches the pause point; `read` reports the notes, the key and the data ledger. Version 2 adds
 * a migration that writes both surfaces and then reaches the pause point too.
 */
function uploadNotes(
  dataDir: string,
  major: 1 | 2,
): { readonly source: string; readonly sha256: string } {
  const manifest: PluginManifest = {
    id: NOTES_ID,
    version: `${String(major)}.0.0`,
    title: "Notes",
    description: "A disposable in-realm plugin whose writes a test can hold mid-flight",
    capabilities: [],
    dataVersion: { major, minor: 0 },
    database: { maxBytes: 4 * 1024 * 1024 },
    contributes: {
      panels: [],
      sections: [],
      elements: [],
      tools: [],
      events: [{ id: "wrote", title: "Wrote" }],
    },
    entry: { server: true },
  };
  const migration = `{
    name: "0001-mark-migrated",
    to: { major: 2, minor: 0 },
    async migrate(storage, database) {
      await database.run("INSERT INTO notes(body) VALUES ('migrated')");
      await storage.set("row", "migrated");
      await pause(storage, database);
    },
  }`;
  const server = `
    import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
    const { defineAction } = globalThis[Symbol.for("manifold.shared")]["@manifold/plugin"];
    const pause = (storage, database) =>
      globalThis[Symbol.for(${JSON.stringify(PAUSE_KEY)})]?.(storage, database);
    export default {
      actions: [
        defineAction({
          name: "write", title: "Write a note", caps: [],
          input: z.strictObject({ body: z.string() }), result: z.strictObject({}),
        }),
        defineAction({
          name: "read", title: "Read the notes", caps: [],
          input: z.strictObject({}), result: z.unknown(),
        }),
      ],
      handlers: {
        async write(ctx, { body }) {
          await ctx.database.run("CREATE TABLE IF NOT EXISTS notes(body TEXT NOT NULL)");
          await ctx.database.run("INSERT INTO notes(body) VALUES (?)", [body]);
          await ctx.storage.set("row", body);
          ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, "wrote", { body });
          await pause(ctx.storage, ctx.database);
          return {};
        },
        async read(ctx) {
          const notes = await ctx.database.query("SELECT body FROM notes ORDER BY rowid");
          return {
            rows: notes.map((note) => note.body),
            row: await ctx.storage.get("row"),
            version: await ctx.storage.dataVersion(),
            migrations: await ctx.storage.appliedMigrations(),
          };
        },
      },
      migrations: [${major === 2 ? migration : ""}],
    };
  `;
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      hardenedContract: HARDENED_CONTRACT_VERSION,
      manifest,
      files: { "server.js": Buffer.from(server).toString("base64") },
    }),
  );
  const uploads = join(dataDir, PLUGIN_UPLOADS_DIR);
  mkdirSync(uploads, { recursive: true });
  const source = join(uploads, `notes-${String(major)}.manifold-plugin.json`);
  writeFileSync(source, bytes);
  return { source, sha256: sha256Hex(bytes) };
}

/** One probe of a held caller: `go` lets it try each data surface once; `tried` says it has. */
interface Probe {
  readonly go: PromiseWithResolvers<void>;
  readonly tried: PromiseWithResolvers<void>;
}

/** One armed hold at the pause point: entered, probed in order, then released to run on. */
interface Hold {
  readonly entered: PromiseWithResolvers<void>;
  readonly probes: readonly Probe[];
  readonly release: PromiseWithResolvers<void>;
}

/**
 * Binds the notes bundle's pause point for one test. Each caller takes the next armed hold, or
 * runs straight through when none is armed — a successor loads the same module and must never
 * stop in it. A probe's attempts land in `timeline` as `late:written` or `late:refused`, each
 * surface tried on its own so one refusal cannot hide the other's write. `close` lets every held
 * caller run to its end and removes the point from the realm.
 */
function pausePoint(timeline: string[]): { arm(probes: number): Hold; close(): void } {
  const armed: Hold[] = [];
  const every: Hold[] = [];
  const point = async (storage: PluginStorage, database: PluginDatabase): Promise<void> => {
    const hold = armed.shift();
    if (hold === undefined) return;
    hold.entered.resolve();
    for (const probe of hold.probes) {
      await probe.go.promise;
      // Async, so a surface that throws before returning a promise still reads as refused.
      const attempts: (() => Promise<unknown>)[] = [
        async () => storage.set("row", "late"),
        async () => database.run("INSERT INTO notes(body) VALUES ('late')"),
      ];
      for (const attempt of attempts) {
        const outcome = await attempt().then(
          () => "late:written",
          () => "late:refused",
        );
        timeline.push(outcome);
      }
      probe.tried.resolve();
    }
    await hold.release.promise;
  };
  Reflect.set(globalThis, Symbol.for(PAUSE_KEY), point);
  return {
    arm(probes) {
      const hold: Hold = {
        entered: Promise.withResolvers<void>(),
        probes: Array.from({ length: probes }, () => ({
          go: Promise.withResolvers<void>(),
          tried: Promise.withResolvers<void>(),
        })),
        release: Promise.withResolvers<void>(),
      };
      armed.push(hold);
      every.push(hold);
      return hold;
    },
    close() {
      for (const hold of every) {
        for (const probe of hold.probes) probe.go.resolve();
        hold.release.resolve();
      }
      Reflect.deleteProperty(globalThis, Symbol.for(PAUSE_KEY));
    },
  };
}

/**
 * One hub's log in a handover test: every line, its writer lines copied into the shared
 * `timeline` as `<role>:<evt>`, and the next line it logs that matches, from now on.
 */
function handoverLog(
  timeline: string[],
  role: string,
): {
  readonly lines: LogLine[];
  readonly onLine: (line: LogLine) => void;
  next(matches: (line: LogLine) => boolean): Promise<LogLine>;
} {
  const lines: LogLine[] = [];
  const waiting = new Set<(line: LogLine) => void>();
  return {
    lines,
    onLine: (line) => {
      if (line.evt === "writer_claimed" || line.evt === "writer_sealed")
        timeline.push(`${role}:${line.evt}`);
      for (const check of waiting) check(line);
    },
    next(matches) {
      const found = Promise.withResolvers<LogLine>();
      const check = (line: LogLine): void => {
        if (!matches(line)) return;
        waiting.delete(check);
        found.resolve(line);
      };
      waiting.add(check);
      return found.promise;
    },
  };
}

/** Resolves once `hold` has the request's code; a request that settles first fails the test. */
async function heldBy(hold: Hold, request: Promise<Response>): Promise<void> {
  const settled = request.then(
    (response) => `answered ${String(response.status)}`,
    (error: unknown) => `failed: ${String(error)}`,
  );
  const early = await Promise.race([hold.entered.promise.then(() => null), settled]);
  if (early !== null) throw new Error(`the request settled before its code was held: ${early}`);
}

/** What the old writer's seal reported, checked against the real three-second deadline. */
function expectCutAtDeadline(lines: readonly LogLine[]): void {
  const sealed = lines.find((line) => line.evt === "writer_sealed")?.fields;
  expect(sealed).toMatchObject({ epoch: 1, settled: false });
  // A lower bound only: admitted work had its full deadline before the cut, never less.
  expect(Number(sealed?.quiesceMs)).toBeGreaterThanOrEqual(2_900);
}

/** The payloads of every `kind` event the directory's history holds, oldest first. */
function announced(dataDir: string, kind: string): unknown[] {
  const db = new Database(join(dataDir, "manifold.db"), { readonly: true, strict: true });
  try {
    return db
      .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE type = ? ORDER BY id")
      .all(kind)
      .map((row) => JSON.parse(row.payload) as unknown);
  } finally {
    db.close();
  }
}

test("an action held past the quiesce deadline is revoked before the successor claims, and never touches its data", async () => {
  const dataDir = directory();
  const timeline: string[] = [];
  const point = pausePoint(timeline);
  const oldLog = handoverLog(timeline, "old");
  const newLog = handoverLog(timeline, "new");
  const old = await hub(dataDir, oldLog.lines, { onLine: oldLog.onLine });
  let successor: RunningServer | undefined;
  try {
    expect(await answer(old, "engine.plugins.install", uploadNotes(dataDir, 1))).toMatchObject({
      ok: true,
    });
    const hold = point.arm(2);
    const atClaim = hold.probes[0]!;
    const afterSuccessorWrote = hold.probes[1]!;
    const settledLate = oldLog.next(
      (line) => line.evt === "action" && line.fields.name === `${NOTES_ID}.write`,
    );
    // Admitted: it writes its note and key and stages its event, then is held.
    const writing = act(old, `${NOTES_ID}.write`, JSON.stringify({ body: "old" }));
    const acknowledged = writing.then(
      (response) => response.status,
      () => "cut" as const,
    );
    await heldBy(hold, writing);

    const stopping = old.stop();
    // The successor's first instant as the writer is the held code's first chance to try again.
    void newLog.next((line) => line.evt === "writer_claimed").then(() => atClaim.go.resolve());
    const starting = hub(dataDir, newLog.lines, { onLine: newLog.onLine });
    await stopping;
    successor = await starting;
    expect(await acknowledged).not.toBe(200);
    expectCutAtDeadline(oldLog.lines);
    expect(newLog.lines.find((line) => line.evt === "writer_claimed")?.fields).toEqual({
      epoch: 2,
      previousEpoch: 1,
      previousState: "sealed",
    });
    await atClaim.tried.promise;
    // The successor starts from exactly what the old writer committed before its seal.
    expect(await answer(successor, `${NOTES_ID}.read`, {})).toEqual({
      ok: true,
      result: { rows: ["old"], row: "old", version: { major: 1, minor: 0 }, migrations: [] },
    });

    expect(await answer(successor, `${NOTES_ID}.write`, { body: "successor" })).toEqual({
      ok: true,
      result: {},
    });
    afterSuccessorWrote.go.resolve();
    await afterSuccessorWrote.tried.promise;
    hold.release.resolve();
    // Its handler returns after the handover, and the old dispatch still does not succeed.
    expect((await settledLate).fields.outcome).not.toBe("ok");
    expect(timeline).toEqual([
      "old:writer_claimed",
      "old:writer_sealed",
      "new:writer_claimed",
      ...["late:refused", "late:refused"], // at the successor's claim
      ...["late:refused", "late:refused"], // after the successor wrote
    ]);
    expect(await answer(successor, `${NOTES_ID}.read`, {})).toEqual({
      ok: true,
      result: {
        rows: ["old", "successor"],
        row: "successor",
        version: { major: 1, minor: 0 },
        migrations: [],
      },
    });
  } finally {
    point.close();
    await old.stop();
    await successor?.stop();
  }
  // The held action's event was staged before the cut and never announced; the successor's was.
  expect(announced(dataDir, "wrote")).toEqual([{ body: "successor" }]);
  expect(writerRecord(dataDir)).toBe("2:sealed");
}, 20_000);

test("a migration held past the quiesce deadline publishes nothing and cannot undo the successor's own upgrade", async () => {
  const dataDir = directory();
  const timeline: string[] = [];
  const point = pausePoint(timeline);
  const oldLog = handoverLog(timeline, "old");
  const newLog = handoverLog(timeline, "new");
  const old = await hub(dataDir, oldLog.lines, { onLine: oldLog.onLine });
  let successor: RunningServer | undefined;
  let restarted: RunningServer | undefined;
  try {
    expect(await answer(old, "engine.plugins.install", uploadNotes(dataDir, 1))).toMatchObject({
      ok: true,
    });
    expect(await answer(old, `${NOTES_ID}.write`, { body: "old" })).toEqual({
      ok: true,
      result: {},
    });
    const upgrade = { ...uploadNotes(dataDir, 2), replace: true };
    const hold = point.arm(2);
    const atClaim = hold.probes[0]!;
    const whileSuccessorMigrates = hold.probes[1]!;
    const settledLate = oldLog.next(
      (line) => line.evt === "action" && line.fields.name === "engine.plugins.install",
    );
    // Admitted: the replacement's migration writes its stage image and draft, then is held.
    const upgrading = act(old, "engine.plugins.install", JSON.stringify(upgrade));
    const acknowledged = upgrading.then(
      (response) => response.status,
      () => "cut" as const,
    );
    await heldBy(hold, upgrading);

    const stopping = old.stop();
    void newLog.next((line) => line.evt === "writer_claimed").then(() => atClaim.go.resolve());
    const starting = hub(dataDir, newLog.lines, { onLine: newLog.onLine });
    await stopping;
    successor = await starting;
    expect(await acknowledged).not.toBe(200);
    expectCutAtDeadline(oldLog.lines);
    await atClaim.tried.promise;
    // Nothing of the interrupted chain was published: version 1 serves, still owing it.
    expect(await answer(successor, `${NOTES_ID}.read`, {})).toEqual({
      ok: true,
      result: { rows: ["old"], row: "old", version: { major: 1, minor: 0 }, migrations: [] },
    });

    // The successor runs the same upgrade from the same bytes and is held mid-migration, so its
    // stage image, draft and candidate artifact sit at the very paths the old chain used.
    const own = point.arm(0);
    const ownUpgrade = act(successor, "engine.plugins.install", JSON.stringify(upgrade));
    await heldBy(own, ownUpgrade);
    whileSuccessorMigrates.go.resolve();
    await whileSuccessorMigrates.tried.promise;
    hold.release.resolve();
    // The old migration returns after the handover, and its install still does not succeed.
    expect((await settledLate).fields.outcome).not.toBe("ok");
    expect(timeline).toEqual([
      "old:writer_claimed",
      "old:writer_sealed",
      "new:writer_claimed",
      ...["late:refused", "late:refused"], // at the successor's claim
      ...["late:refused", "late:refused"], // while the successor's own chain is staged
    ]);

    own.release.resolve();
    expect(await (await ownUpgrade).json()).toMatchObject({
      ok: true,
      result: { id: NOTES_ID, version: "2.0.0" },
    });
    const upgraded = {
      ok: true,
      result: {
        rows: ["old", "migrated"],
        row: "migrated",
        version: { major: 2, minor: 0 },
        migrations: ["0001-mark-migrated"],
      },
    };
    expect(await answer(successor, `${NOTES_ID}.read`, {})).toEqual(upgraded);
    // Its files are its own as well: the next start re-verifies the installed bundle from disk.
    await successor.stop();
    restarted = await hub(dataDir, []);
    expect(await answer(restarted, `${NOTES_ID}.read`, {})).toEqual(upgraded);
  } finally {
    point.close();
    await old.stop();
    await successor?.stop();
    await restarted?.stop();
  }
  expect(writerRecord(dataDir)).toBe("3:sealed");
}, 20_000);
