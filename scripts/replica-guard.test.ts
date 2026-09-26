import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplicaGuardRefusal, requireSealedReplica } from "./replica-guard.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

test("restored file verification has a finite admission deadline", () => {
  const { data } = fixture();
  const auxiliary = join(data, "plugin.db");
  contents(auxiliary, "current state");
  const main = sealed(data, "plugin.db", auxiliary);
  requireSealedReplica(main);
  const clock = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER);
  try {
    expect(() => requireSealedReplica(main)).toThrow(ReplicaGuardRefusal);
  } finally {
    clock.mockRestore();
  }
});
