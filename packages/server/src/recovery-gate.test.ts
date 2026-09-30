import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RecoveryGateLifetime,
  RECOVERY_GATE_FILE,
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

test("capture waits for mutation cleanup and a retired callback cannot borrow the successor's exclusion", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-capture-retirement-"));
  const main = new Database(join(root, "manifold.db"));
  const plugin = new Database(join(root, "plugin.db"));
  main.exec("PRAGMA journal_mode=WAL");
  main.exec("CREATE TABLE published(value TEXT); INSERT INTO published VALUES ('old')");
  plugin.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('old')");
  const old = new RecoveryGateLifetime();
  const successor = new RecoveryGateLifetime();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const nextEntered = Promise.withResolvers<void>();
  const nextResume = Promise.withResolvers<void>();
  let retired: Promise<unknown> = Promise.resolve();
  let replacing: Promise<unknown> = Promise.resolve();
  let capturing: Promise<unknown> = Promise.resolve();
  try {
    retired = old.run(root, async () => {
      plugin.exec("UPDATE payload SET value='draft'");
      entered.resolve();
      await resume.promise;
      withRecoveryGateSync(root, () => plugin.exec("UPDATE payload SET value='stale'"));
    });
    await entered.promise;
    // An independent synchronous entry shares mutation exclusion, not ownership authority.
    expect(
      withRecoveryGateSync(root, () => main.query("SELECT value FROM published").all()),
    ).toEqual([{ value: "old" }]);
    capturing = withRecoveryCaptureFence(root, () => {
      expect(() =>
        withRecoveryGateSync(root, () => plugin.exec("UPDATE payload SET value='mixed'")),
      ).toThrow(/database_busy/);
      return {
        published: main.query("SELECT value FROM published").all(),
        payload: plugin.query("SELECT value FROM payload").all(),
      };
    });
    old.close(() => {
      withRecoveryGateSync(root, () => plugin.exec("UPDATE payload SET value='old'"));
    });
    replacing = successor.run(root, async () => {
      plugin.exec("UPDATE payload SET value='next'");
      nextEntered.resolve();
      await nextResume.promise;
      main.exec("UPDATE published SET value='next'");
    });
    await nextEntered.promise;
    resume.resolve();
    await expect(retired).rejects.toThrow("the recovery gate owner is closed");
    // The retired promise settling must not release the successor's real kernel lock.
    const contender = new Database(join(root, RECOVERY_GATE_FILE));
    try {
      expect(() => contender.exec("BEGIN EXCLUSIVE")).toThrow(/locked/);
    } finally {
      contender.close();
    }
    nextResume.resolve();
    await replacing;
    expect(await capturing).toEqual({
      published: [{ value: "next" }],
      payload: [{ value: "next" }],
    });
  } finally {
    resume.resolve();
    nextResume.resolve();
    await Promise.allSettled([retired, replacing, capturing]);
    old.close(() => {});
    successor.close(() => {});
    main.close();
    plugin.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retirement between acquisition and entry cannot start a mutation or strand capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-capture-entry-"));
  const main = new Database(join(root, "manifold.db"));
  main.exec("CREATE TABLE published(value TEXT)");
  const owner = new RecoveryGateLifetime();
  try {
    const entering = owner.run(root, async () => {
      main.exec("INSERT INTO published VALUES ('retired')");
    });
    owner.close(() => {});
    await expect(entering).rejects.toThrow("the recovery gate owner is closed");
    expect(
      await withRecoveryCaptureFence(root, () => main.query("SELECT value FROM published").all()),
    ).toEqual([]);
  } finally {
    main.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unconfirmed cleanup retains capture exclusion even after the retired mutation settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-capture-fail-stop-"));
  const main = new Database(join(root, "manifold.db"));
  main.exec("CREATE TABLE published(value TEXT); INSERT INTO published VALUES ('retained')");
  main.close();
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { Database } from "bun:sqlite";
    import { RecoveryGateLifetime, withRecoveryGateSync, RECOVERY_GATE_FILE } from
      ${JSON.stringify(join(import.meta.dir, "recovery-gate.ts"))};
    const root = ${JSON.stringify(root)};
    const owner = new RecoveryGateLifetime();
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const running = owner.run(root, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    const outcomes = [];
    try { owner.close(() => { throw new Error("cleanup unknown"); }); }
    catch (error) { outcomes.push(error.message); }
    resume.resolve();
    await running;
    try { withRecoveryGateSync(root, () => outcomes.push("borrowed")); }
    catch (error) { outcomes.push(error.code); }
    const contender = new Database(root + "/" + RECOVERY_GATE_FILE);
    try { contender.exec("BEGIN EXCLUSIVE"); outcomes.push("captured"); }
    catch (error) { outcomes.push(error.code); }
    contender.close();
    console.log(JSON.stringify(outcomes));
    process.exit(0);
  `,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(error);
    expect(JSON.parse(output)).toEqual(["cleanup unknown", "SQLITE_BUSY", "SQLITE_BUSY"]);
    // Only confirmed process death releases a failed-close fence.
    expect(
      await withRecoveryCaptureFence(root, () => {
        const reader = new Database(join(root, "manifold.db"), { readonly: true });
        try {
          return reader.query("SELECT value FROM published").all();
        } finally {
          reader.close();
        }
      }),
    ).toEqual([{ value: "retained" }]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live host's IPC context outlives one gate lease but not the host's retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-capture-context-"));
  const main = new Database(join(root, "manifold.db"));
  main.exec("CREATE TABLE published(value TEXT)");
  const owner = new RecoveryGateLifetime();
  const live = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  let continued: Promise<unknown> = Promise.resolve();
  let retired: Promise<unknown> = Promise.resolve();
  try {
    await owner.run(root, async () => {
      continued = live.promise.then(() =>
        withRecoveryGateSync(root, () => main.exec("INSERT INTO published VALUES ('live')")),
      );
      retired = late.promise.then(() =>
        withRecoveryGateSync(root, () => main.exec("INSERT INTO published VALUES ('retired')")),
      );
    });
    live.resolve();
    await continued;
    owner.close(() => {});
    late.resolve();
    await expect(retired).rejects.toThrow("the recovery gate owner is closed");
    expect(
      await withRecoveryCaptureFence(root, () => main.query("SELECT value FROM published").all()),
    ).toEqual([{ value: "live" }]);
  } finally {
    live.resolve();
    late.resolve();
    await Promise.allSettled([continued, retired]);
    owner.close(() => {});
    main.close();
    rmSync(root, { recursive: true, force: true });
  }
});
