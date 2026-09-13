import { defineServerAction, defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "./manifest.json";

/*
  THE REFERENCE PLUGIN WHOSE DATA IS ROWS (ADR 0034). Its manifest declares `database`, which
  is the whole of what makes `ctx.database` exist; the table is made in `onEnable`, where a
  plugin puts its own durable state in order, and one door exercises the three verbs: `run` for
  a write, `batch` for a transaction that commits, `batch` for one that must roll back whole,
  and `query` for the count that proves the rollback left nothing behind. Every call crosses
  the process boundary as a `call` frame the host answers against the plugin's own file.
 */

const records = defineServerAction({
  name: "records",
  title: "Exercise this plugin's own tables",
  caps: ["containers:read"],
  input: z.strictObject({}),
  result: z.strictObject({ kept: z.number().int(), rolledBack: z.boolean() }),
});

export const handlers = {
  async records(
    ctx: GuestCtx,
  ): Promise<{ kept: number; rolledBack: boolean } | { refused: string }> {
    const database = ctx.database;
    if (database === undefined) return { refused: "this plugin declared a database and got none" };
    await database.run("INSERT INTO records(body) VALUES (?)", ["one"]);
    const committed = await database.batch([
      { sql: "INSERT INTO records(body) VALUES (?)", params: ["two"] },
      { sql: "INSERT INTO records(body) VALUES (?)", params: ["three"] },
    ]);
    if (committed.length !== 2) return { refused: "a batch answers one result per statement" };
    // The second statement violates NOT NULL, so the first must not survive it: a batch is the
    // transaction, and a plugin reads the rollback in the count rather than trusting it.
    let rolledBack = false;
    try {
      await database.batch([
        { sql: "INSERT INTO records(body) VALUES (?)", params: ["four"] },
        { sql: "INSERT INTO records(body) VALUES (NULL)" },
      ]);
    } catch {
      rolledBack = true;
    }
    const counted = await database.query<{ n: number }>("SELECT count(*) AS n FROM records");
    return { kept: Number(counted[0]?.n ?? 0), rolledBack };
  },
};

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [records],
  handlers,
  lifecycle: {
    async onEnable(ctx) {
      await ctx.database?.run(
        "CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
      );
    },
  },
});
