import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  waitForRecoveryCapture,
  withRecoveryGateSync,
  withRecoveryCaptureFence,
} from "./recovery-gate.ts";

test("a watchdog kills synchronous capture, releases both kernel fences, and cannot report success", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-capture-watchdog-"));
  const ready = Promise.withResolvers<void>();
  const writer = new Database(join(root, "manifold.db"));
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA busy_timeout=0");
  writer.exec("CREATE TABLE grants(value TEXT)");
  writer.exec("INSERT INTO grants VALUES ('authorized')");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { withRecoveryCaptureFence } from ${JSON.stringify(join(import.meta.dir, "recovery-gate.ts"))};
    await withRecoveryCaptureFence(${JSON.stringify(root)}, () => {
      process.send('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
    process.exit(0);
  `,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        if (message === "held") ready.resolve();
      },
    },
  );
  try {
    await Promise.race([
      ready.promise,
      child.exited.then(() => {
        throw new Error("capture exited before acquiring its fences");
      }),
    ]);
    expect(() => writer.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    expect(() => withRecoveryGateSync(root, () => {})).toThrow(/database_busy/);
    // Real child/kernel locking and a synchronously blocked event loop require the platform timer.
    await expect(waitForRecoveryCapture(child, 100)).rejects.toThrow("checkpoint_timeout");
    expect(child.signalCode).toBe("SIGKILL");
    withRecoveryGateSync(root, () => {
      writer.exec("BEGIN IMMEDIATE");
      writer.exec("DELETE FROM grants");
      writer.exec("COMMIT");
    });
    expect(writer.query("SELECT * FROM grants").all()).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the held main fence permits an independent main snapshot before immutable plugin payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-capture-order-"));
  const writer = new Database(join(root, "manifold.db"));
  const plugin = new Database(join(root, "plugin.db"));
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA busy_timeout=0");
  writer.exec("CREATE TABLE published(nonce TEXT); INSERT INTO published VALUES ('identity')");
  plugin.exec("PRAGMA journal_mode=WAL");
  plugin.exec("CREATE TABLE payload(nonce TEXT, body BLOB)");
  plugin.query("INSERT INTO payload VALUES (?,?)").run("identity", new Uint8Array([1, 2, 3]));
  try {
    await withRecoveryCaptureFence(root, () => {
      const mainReader = new Database(join(root, "manifold.db"), { readonly: true });
      const pluginReader = new Database(join(root, "plugin.db"), { readonly: true });
      try {
        mainReader.exec(`VACUUM INTO '${join(root, "main-captured").replaceAll("'", "''")}'`);
        expect(() => writer.exec("DELETE FROM published")).toThrow(/locked/);
        pluginReader.exec(`VACUUM INTO '${join(root, "plugin-captured").replaceAll("'", "''")}'`);
      } finally {
        mainReader.close();
        pluginReader.close();
      }
    });
    const mainCopy = new Database(join(root, "main-captured"), { readonly: true });
    const pluginCopy = new Database(join(root, "plugin-captured"), { readonly: true });
    try {
      expect(mainCopy.query("SELECT nonce FROM published").all()).toEqual([{ nonce: "identity" }]);
      expect(pluginCopy.query("SELECT nonce,hex(body) AS body FROM payload").all()).toEqual([
        { nonce: "identity", body: "010203" },
      ]);
    } finally {
      mainCopy.close();
      pluginCopy.close();
    }
    writer.exec("DELETE FROM published");
    expect(writer.query("SELECT * FROM published").all()).toEqual([]);
  } finally {
    writer.close();
    plugin.close();
    rmSync(root, { recursive: true, force: true });
  }
});
