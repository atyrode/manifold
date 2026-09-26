import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@manifold/protocol";
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
  onLine?: (line: LogLine) => void,
): Promise<RunningServer> {
  return startServer({
    config: loadConfig({
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: dataDir,
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    }),
    logger: recordingLogger(lines, onLine),
    announce: false,
  });
}

function createContainer(
  server: RunningServer,
  name: string,
  body?: ReadableStream,
): Promise<Response> {
  return fetch(`${server.publicUrl}/api/actions/core.index.createContainer`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
    body: body ?? JSON.stringify({ name }),
  });
}

async function containerNames(server: RunningServer): Promise<string[]> {
  const response = await fetch(`${server.publicUrl}/api/actions/core.index.listContainers`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
    body: "{}",
  });
  const outcome = (await response.json()) as {
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
    const starting = hub(dataDir, secondLines, (line) => {
      if (line.evt === "writer_waiting") waiting.resolve();
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
