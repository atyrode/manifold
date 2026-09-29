import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Y, ELEMENTS_KEY, LAYOUT_KEY } from "@manifold/scene";
import { openDatabase } from "../src/db.ts";
import { ServerStore, sha256Hex } from "../src/stores.ts";

const HOME = "home:/終";
const ID = "note:/α:終";
const EPOCH = "retained-original-epoch";
interface Row { container_id: string; epoch: string; rev: number; ts: number; hash: string; doc: Uint8Array }

function fixture(): { dir: string; path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "manifold-text-history-"));
  const path = join(dir, "manifold.db");
  const db = openDatabase(path);
  db.query("UPDATE meta SET value = '48' WHERE key = 'schema_version'").run();
  db.query("INSERT INTO containers(id, name, created_at, discipline) VALUES (?, 'Historical home', 17, 'canvas')").run(HOME);
  db.query("INSERT INTO plugin_kv VALUES ('core.notes', '$version', '1.7')").run();
  db.query("INSERT INTO plugin_kv VALUES ('core.notes', '$migration:old-move', '123')").run();
  db.query("INSERT INTO plugin_kv VALUES ('core.notes', 'opaque', ?)").run('{"by":"core.notes","bytes":"\\u0000"}');
  db.query("INSERT INTO plugin_kv VALUES ('engine.plugins', '$owner:text', 'core.notes')").run();
  db.query("INSERT INTO plugin_kv VALUES ('vendor.other', 'opaque', 'core.notes')").run();
  db.query("INSERT INTO meta VALUES ('plugins:element-owners', ?)").run('{"text":"core.notes","portal":"core.portal"}');
  return { dir, path, db };
}
function legacy(body: string | Y.Text = new Y.Text("α🙂é\u0000終")): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 0; // synthetic clients must skip even low retained author IDs
  const element = new Y.Map<unknown>();
  for (const [key, value] of Object.entries({ id: ID, type: "text", x: 12, y: 34, width: 320, height: 180, z: 5,
    fontSize: 18, color: "#123456", lastEditedBy: "author-original", lastEditedAt: 111 })) element.set(key, value);
  element.set("text", body);
  doc.getMap(ELEMENTS_KEY).set(ID, element);
  const leaf = new Y.Map<unknown>();
  leaf.set("kind", "leaf");
  leaf.set("ref", { kind: "element", elementId: ID });
  doc.getMap(LAYOUT_KEY).set("root", leaf);
  doc.getMap("unrelated").set("opaque", { owner: "core.notes", text: "unchanged" });
  return doc;
}
function save(db: Database, doc: Y.Doc, rev: number): Uint8Array {
  const bytes = Y.encodeStateAsUpdate(doc);
  db.query("INSERT INTO scene_docs VALUES (?, ?, ?, ?, ?, ?)")
    .run(HOME, EPOCH, rev, 1000 + rev, sha256Hex(bytes), bytes);
  return bytes;
}
function rows(db: Database): Row[] {
  return db.query<Row, []>("SELECT * FROM scene_docs ORDER BY rev").all();
}
function decode(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}
function body(doc: Y.Doc, migrated = true): Y.Text {
  const record = doc.getMap<Y.Map<unknown>>(migrated ? "texts" : ELEMENTS_KEY).get(migrated ? `core.text:${ID}` : ID);
  const text = record?.get("text");
  if (!(text instanceof Y.Text)) throw new Error("fixture lacks a collaborative body");
  return text;
}
function image(db: Database): Record<string, unknown[]> {
  return Object.fromEntries(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map(({ name }) => [name, db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

describe("migration 49: retained text ownership", () => {
  test("all history keeps type/character identity, formatting and concurrent legacy edit merge semantics", () => {
    const f = fixture();
    let db = f.db;
    const source = legacy();
    const docs: Y.Doc[] = [source];
    try {
      body(source, false).format(0, 3, { bold: true, color: "red" });
      const older = save(db, source, 4);
      const originalBodyId = body(source, false)._item?.id;
      const offline = decode(older);
      offline.clientID = 2;
      docs.push(offline);
      const beforeOffline = Y.encodeStateVector(offline);
      body(offline, false).insert(1, " peer ");
      body(offline, false).delete(9, 1);
      const concurrent = Y.encodeStateAsUpdate(offline, beforeOffline);
      // Even a retained author outside Yjs's ordinary uint32 generator must not collide.
      source.clientID = 0x1_0000_0000;
      body(source, false).insert(0, "new ", { italic: true });
      body(source, false).delete(body(source, false).length - 1, 1);
      const element = source.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID);
      element?.set("lastEditedBy", "author-new");
      element?.set("lastEditedAt", 222);
      const newer = save(db, source, 9);
      const before = rows(db);
      db.close();
      db = openDatabase(f.path);
      const after = rows(db);
      expect(after.map(({ doc: _doc, hash: _hash, ...identity }) => identity))
        .toEqual(before.map(({ doc: _doc, hash: _hash, ...identity }) => identity));
      for (const [index, bytes] of [older, newer].entries()) {
        const original = decode(bytes);
        const migrated = decode(after[index]!.doc);
        docs.push(original, migrated);
        expect(body(migrated)._item?.id).toEqual(originalBodyId);
        expect(body(migrated).toDelta()).toEqual(body(original, false).toDelta());
        expect(migrated.getMap(LAYOUT_KEY).toJSON()).toEqual(original.getMap(LAYOUT_KEY).toJSON());
        expect(migrated.getMap("unrelated").toJSON()).toEqual(original.getMap("unrelated").toJSON());
        const oldElement = original.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)!;
        const newElement = migrated.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)!;
        const { text: _text, ...presentation } = oldElement.toJSON();
        expect(newElement.toJSON()).toEqual({ ...presentation, type: "canvas_note", document: JSON.stringify([HOME, ID]) });
        const record = migrated.getMap<Y.Map<unknown>>("texts").get(`core.text:${ID}`)!;
        expect(record.get("lastEditedBy")).toBe(oldElement.get("lastEditedBy"));
        expect(record.get("lastEditedAt")).toBe(oldElement.get("lastEditedAt"));
        expect(after[index]!.hash).toBe(sha256Hex(after[index]!.doc));
      }
      const expected = decode(newer);
      docs.push(expected);
      Y.applyUpdate(expected, concurrent);
      for (const order of [[0, 1], [1, 0]]) {
        const merged = new Y.Doc();
        docs.push(merged);
        Y.applyUpdate(merged, after[order[0]!]!.doc);
        Y.applyUpdate(merged, concurrent);
        Y.applyUpdate(merged, after[order[1]!]!.doc);
        Y.applyUpdate(merged, after[0]!.doc);
        expect(body(merged).toDelta()).toEqual(body(expected, false).toDelta());
        expect(body(merged)._item?.id).toEqual(originalBodyId);
      }
    } finally { for (const doc of docs) doc.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  test("legacy scalar revisions have stable distinct live text streams, including empty text", () => {
    const f = fixture();
    let db = f.db;
    const source = legacy("");
    try {
      save(db, source, 1);
      source.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)?.set("text", "🙂\u0000α");
      save(db, source, 2);
      db.close(); db = openDatabase(f.path);
      const converted = rows(db);
      const first = decode(converted[0]!.doc);
      const second = decode(converted[1]!.doc);
      expect(body(first).toString()).toBe("");
      expect(body(second).toString()).toBe("🙂\u0000α");
      Y.applyUpdate(first, converted[1]!.doc);
      Y.applyUpdate(second, converted[0]!.doc);
      expect(body(first).toString()).toBe("🙂\u0000α");
      expect(body(second).toString()).toBe("🙂\u0000α");
      body(first).insert(0, "editable ");
      Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
      expect(body(second).toString()).toBe("editable 🙂\u0000α");
      first.destroy(); second.destroy();
    } finally { source.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  test.each([[false, false], [false, true], [true, false], [true, true]])(
    "notes disabled=%s, canvas disabled=%s preserves independent state and causal attribution", (notesOff, canvasOff) => {
      const f = fixture(); let db = f.db;
      try {
        const disabled = ["vendor.off", ...(notesOff ? ["core.notes"] : []), ...(canvasOff ? ["core.canvas"] : [])];
        db.query("INSERT INTO meta VALUES ('plugins:disabled', ?)").run(JSON.stringify(disabled));
        db.query("INSERT INTO meta VALUES ('plugins:attribution', ?)").run(JSON.stringify({
          "core.notes": { by: "notes-admin", at: 101 }, "core.canvas": { by: "canvas-admin", at: 202 },
          "vendor.off": { by: "core.notes", at: 303 },
        }));
        db.close(); db = openDatabase(f.path);
        const store = new ServerStore(db);
        expect(store.disabledPlugins().has("core.text")).toBe(notesOff);
        expect(store.disabledPlugins().has("core.canvas.note")).toBe(notesOff || canvasOff);
        expect(store.disabledPlugins().has("core.canvas")).toBe(canvasOff);
        expect(store.disabledPlugins().has("core.notes")).toBeFalse();
        expect(store.pluginAttribution().get("core.text")).toEqual({ by: "notes-admin", at: 101 });
        expect(store.pluginAttribution().get("core.canvas.note"))
          .toEqual(!notesOff && canvasOff ? { by: "canvas-admin", at: 202 } : { by: "notes-admin", at: 101 });
        expect(store.pluginAttribution().get("vendor.off")).toEqual({ by: "core.notes", at: 303 });
      } finally { db.close(); rmSync(f.dir, { recursive: true, force: true }); }
    },
  );

  test("corrupt latest rows remain evidence; converted fallback, references, grants, storage and reopen survive", async () => {
    const f = fixture(); let db = f.db;
    const source = legacy();
    try {
      db.query("UPDATE containers SET discipline = 'composition'").run();
      save(db, source, 4);
      const bad = new Uint8Array([255, 255]);
      db.query("INSERT INTO scene_docs VALUES (?, ?, 5, 1005, 'wrong-hash', ?)").run(HOME, EPOCH, bad);
      db.query("INSERT INTO scene_docs VALUES (?, ?, 6, 1006, ?, ?)").run(HOME, EPOCH, sha256Hex(bad), bad);
      const grant = db.query("INSERT INTO grants VALUES (?, 'principal', 'p', ?, '[\"scenes:write\"]', 'allow', 'subtree', 'grantor', 43)");
      grant.run("home-grant", `manifold://container/${encodeURIComponent(HOME)}`);
      grant.run("element-grant", `manifold://container/${encodeURIComponent(HOME)}/element/${encodeURIComponent(ID)}`);
      grant.run("plugin-grant", "manifold://plugin/core.notes");
      db.query("INSERT INTO principals(id, kind, name, color, created_at) VALUES ('p', 'human', 'Historical author', '#123456', 1)").run();
      db.query("INSERT INTO tokens(id, hash, principal_id, caps, container_id, created_at, grant_id) VALUES ('credential', ?, 'p', '[\"containers:read\",\"scenes:write\"]', ?, 2, 'home-grant')")
        .run(sha256Hex("disposable-historical-credential"), HOME);
      db.query("INSERT INTO dials(id, origin, secret, ref, caps, dialed_at) VALUES ('plugin-reference', 'https://example.invalid', 'disposable-fixture', ?, '[]', 3)")
        .run(JSON.stringify({ kind: "plugin", pluginId: "core.notes" }));
      db.query("INSERT INTO machine_jobs(job_id, machine_id, plugin_id, digest, request, state, created_at) VALUES ('historical-job', 'm', 'core.notes', 'historical-digest', '{}', 'exited', 4)").run();
      const before = image(db);
      db.close(); db = openDatabase(f.path);
      const store = new ServerStore(db);
      const invalid: number[] = [];
      const latest = store.latestDoc(HOME, (_error, row) => invalid.push(row.rev));
      expect(latest?.epoch).toBe(EPOCH); expect(latest?.rev).toBe(4);
      expect(invalid).toEqual([6, 5]);
      expect(rows(db).slice(1)).toEqual((before.scene_docs as Row[]).slice(1));
      const doc = decode(latest!.doc);
      expect(doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)?.get("type")).toBe("text");
      expect(body(doc).toString()).toBe("α🙂é\u0000終"); doc.destroy();
      expect(db.query("SELECT * FROM containers").all()).toEqual(before.containers);
      expect(db.query("SELECT * FROM tokens").all()).toEqual(before.tokens);
      expect(db.query("SELECT * FROM machine_jobs").all()).toEqual(before.machine_jobs);
      expect(db.query<{ ref: string }, []>("SELECT ref FROM dials WHERE id = 'plugin-reference'").get()?.ref)
        .toBe(JSON.stringify({ kind: "plugin", pluginId: "core.text" }));
      expect(db.query("SELECT * FROM grants WHERE id != 'plugin-grant'").all())
        .toEqual((before.grants as { id: string }[]).filter((row) => row.id !== "plugin-grant"));
      expect(db.query<{ node: string }, []>("SELECT node FROM grants WHERE id = 'plugin-grant'").get()?.node)
        .toBe("manifold://plugin/core.text");
      expect(await store.pluginStorage("core.text").get("opaque")).toBe('{"by":"core.notes","bytes":"\\u0000"}');
      expect(await store.pluginStorage("core.text").dataVersion()).toEqual({ major: 1, minor: 7 });
      expect(await store.pluginStorage("core.text").appliedMigrations()).toEqual(["old-move"]);
      expect(await store.pluginStorage("vendor.other").get("opaque")).toBe("core.notes");
      expect(store.elementOwners().get("text")).toBe("core.text");
      expect(store.elementOwners().get("canvas_note")).toBe("core.canvas.note");
      expect(await store.pluginStorage("engine.plugins").get("$owner:canvas_note")).toBe("core.canvas.note");
      expect(store.pluginAttribution().has("core.canvas.note")).toBeFalse();
      const once = image(db);
      db.close(); db = openDatabase(f.path);
      expect(image(db)).toEqual(once);
      // Restore the COMPLETE image, not only scene_docs: schema, storage, authority and
      // administration must all roll back together. Actual old-binary proof is external.
      const restoredPath = join(f.dir, "restored.db");
      copyFileSync(`${f.path}.pre-v49.bak`, restoredPath);
      const restored = new Database(restoredPath, { strict: true });
      expect(image(restored)).toEqual(before);
      expect(new ServerStore(restored).getMeta("schema_version")).toBe("48");
      restored.close();
    } finally { source.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  test("historical deletion tombstones also delete a merged older converted record", () => {
    const f = fixture(); let db = f.db; const source = legacy();
    try {
      save(db, source, 1);
      source.getMap(ELEMENTS_KEY).delete(ID);
      save(db, source, 2);
      db.close(); db = openDatabase(f.path);
      const converted = rows(db);
      const merged = decode(converted[0]!.doc);
      Y.applyUpdate(merged, converted[1]!.doc);
      expect(merged.getMap("texts").has(`core.text:${ID}`)).toBeFalse();
      expect(merged.getMap(ELEMENTS_KEY).has(ID)).toBeFalse();
      merged.destroy();
    } finally { source.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  test("delete/undo and replacement generations preserve their own body identities and merge ordering", () => {
    const f = fixture(); let db = f.db; const source = legacy();
    const undo = new Y.UndoManager(source.getMap(ELEMENTS_KEY));
    const expected: (Y.ID | undefined)[] = [];
    try {
      expected.push(body(source, false)._item?.id);
      save(db, source, 1);
      source.getMap(ELEMENTS_KEY).delete(ID);
      save(db, source, 2);
      undo.undo();
      expected.push(body(source, false)._item?.id);
      save(db, source, 3);
      const restored = body(source, false).toDelta();
      const beforeEdit = Y.encodeStateVector(source);
      body(source, false).insert(0, "concurrent restored ");
      const concurrent = Y.encodeStateAsUpdate(source, beforeEdit);
      db.close(); db = openDatabase(f.path);
      const converted = rows(db);
      const first = decode(converted[0]!.doc);
      const last = decode(converted[2]!.doc);
      expect(body(first)._item?.id).toEqual(expected[0]);
      expect(body(last)._item?.id).toEqual(expected[1]);
      expect(body(last).toDelta()).toEqual(restored);
      Y.applyUpdate(first, converted[2]!.doc);
      Y.applyUpdate(first, converted[1]!.doc);
      Y.applyUpdate(first, concurrent);
      Y.applyUpdate(last, converted[0]!.doc);
      Y.applyUpdate(last, converted[1]!.doc);
      Y.applyUpdate(last, concurrent);
      expect(body(first).toDelta()).toEqual(body(source, false).toDelta());
      expect(body(last).toDelta()).toEqual(body(source, false).toDelta());
      first.destroy(); last.destroy();
    } finally { undo.destroy(); source.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });

  test.each(["metadata", "generation"] as const)(
    "concurrent %s histories retain the legacy map winner in either merge order", (change) => {
      const f = fixture(); let db = f.db; const source = legacy();
      const branches: Y.Doc[] = [];
      try {
        const initial = save(db, source, 1);
        for (const client of [11, 12]) {
          const branch = decode(initial);
          branch.clientID = client;
          branches.push(branch);
          let element = branch.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)!;
          if (change === "generation") {
            const { text: _body, ...fields } = element.toJSON();
            element = new Y.Map<unknown>(Object.entries(fields));
            element.set("text", new Y.Text(`generation-${client}`));
            branch.getMap(ELEMENTS_KEY).set(ID, element);
          } else {
            body(branch, false).insert(0, `branch-${client} `);
          }
          element.set("lastEditedBy", `author-${client}`);
          element.set("lastEditedAt", client);
          save(db, branch, client);
          Y.applyUpdate(source, Y.encodeStateAsUpdate(branch));
        }
        db.close(); db = openDatabase(f.path);
        const converted = rows(db);
        for (const order of [[1, 2], [2, 1]]) {
          const merged = decode(converted[order[0]!]!.doc);
          Y.applyUpdate(merged, converted[order[1]!]!.doc);
          expect(body(merged).toDelta()).toEqual(body(source, false).toDelta());
          expect(body(merged)._item?.id).toEqual(body(source, false)._item?.id);
          const record = merged.getMap<Y.Map<unknown>>("texts").get(`core.text:${ID}`)!;
          expect(record.get("lastEditedBy")).toBe("author-12");
          expect(record.get("lastEditedAt")).toBe(12);
          merged.destroy();
        }
      } finally { for (const branch of branches) branch.destroy(); source.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
    },
  );

  test.each(["target-kv", "target-state", "target-attribution", "reservation", "legacy-reservation", "namespace", "document", "embed", "kind-changed", "scalar-id-reuse", "late-write-failure"])(
    "%s refuses without partial scene, authority, administration or ledger publication", (collision) => {
      const f = fixture(); let db = f.db;
      const source = collision === "scalar-id-reuse" ? legacy("one") : legacy();
      try {
        save(db, source, 1);
        if (collision === "target-kv") db.query("INSERT INTO plugin_kv VALUES ('core.text', 'already', 'owned')").run();
        if (collision === "target-state") db.query("INSERT INTO meta VALUES ('plugins:disabled', '[\"core.canvas.note\"]')").run();
        if (collision === "target-attribution") db.query("INSERT INTO meta VALUES ('plugins:attribution', '{\"core.text\":{\"by\":\"owner\",\"at\":7}}')").run();
        if (collision === "reservation") db.query("UPDATE meta SET value = '{\"text\":\"core.notes\",\"canvas_note\":\"vendor.owner\"}' WHERE key = 'plugins:element-owners'").run();
        if (collision === "legacy-reservation") db.query("INSERT INTO plugin_kv VALUES ('engine.plugins', '$owner:canvas_note', 'vendor.owner')").run();
        if (collision === "namespace") source.getMap("texts").set(`core.text:${ID}`, new Y.Map());
        if (collision === "document") source.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)?.set("document", "occupied");
        if (collision === "embed") body(source, false).insertEmbed(0, { image: "unsupported" });
        if (collision === "kind-changed") source.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get(ID)?.set("type", "other");
        if (collision === "late-write-failure") db.exec("CREATE TRIGGER refuse_text_version BEFORE INSERT ON meta WHEN NEW.key = 'schema_version' AND NEW.value = '49' BEGIN SELECT RAISE(ABORT, 'fixture final ledger failure'); END");
        if (collision === "scalar-id-reuse") {
          const conflicting = legacy("two");
          save(db, conflicting, 2);
          conflicting.destroy();
        } else {
          save(db, source, 2);
        }
        const before = image(db);
        db.close();
        expect(() => openDatabase(f.path)).toThrow();
        db = new Database(f.path, { strict: true });
        expect(image(db)).toEqual(before);
        const backup = new Database(`${f.path}.pre-v49.bak`, { strict: true });
        expect(image(backup)).toEqual(before); backup.close();
      } finally { source.destroy(); db.close(); rmSync(f.dir, { recursive: true, force: true }); }
    },
  );
});
