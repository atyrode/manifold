import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase, SCHEMA_VERSION } from "../packages/server/src/db.ts";
import { createPreviewSeed } from "./preview-seed.ts";

test("preview seed projects representative data without durable authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-preview-seed-"));
  const sourcePath = join(directory, "source.db");
  const destinationPath = join(directory, "preview.db");
  try {
    const source = openDatabase(sourcePath);
    source.exec(`
      INSERT INTO container_folders(id,name,created_at,parent_folder_id,sort_order)
        VALUES ('folder','Representative folder',1,NULL,0);
      INSERT INTO containers(id,name,created_at,sort_order,folder_id,discipline)
        VALUES ('canvas','Representative canvas',2,0,'folder','canvas');
      INSERT INTO scene_docs(container_id,epoch,rev,ts,hash,doc)
        VALUES ('canvas','epoch',1,3,'scene-hash',X'010203');
      INSERT INTO principals(id,kind,name,color,created_at,origin)
        VALUES ('development-human','human','Development human','#000000',4,NULL);
      INSERT INTO grants(id,principal_kind,principal_id,node,caps,effect,reach,created_by,created_at)
        VALUES ('development-grant','principal','development-human','manifold://','["*"]','allow','subtree','owner',4);
      INSERT INTO tokens(id,hash,principal_id,minted_by,caps,container_id,created_at,revoked_at,grant_id,expires_at)
        VALUES ('development-token','${"a".repeat(64)}','development-human','owner','["*"]',NULL,4,NULL,'development-grant',NULL);
      INSERT INTO dials(id,origin,secret,ref,caps,title,dialed_at,revoked_at)
        VALUES ('development-dial','https://host.invalid','development-dial-secret','manifold://container/canvas','[]','Development dial',4,NULL);
      INSERT INTO plugin_kv(plugin_id,key,value)
        VALUES ('example.secret','credential','development-plugin-secret');
      INSERT INTO meta(key,value) VALUES ('jobs:signing-key','development-signing-key');
      CREATE TABLE future_authority(secret TEXT NOT NULL);
      INSERT INTO future_authority(secret) VALUES ('future-table-authority-sentinel');
      ALTER TABLE containers ADD COLUMN future_authority TEXT;
      UPDATE containers SET future_authority = 'future-column-authority-sentinel';
    `);
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    source.close();

    createPreviewSeed(sourcePath, destinationPath);

    const preview = new Database(destinationPath, { readonly: true, strict: true });
    expect(
      preview
        .query("SELECT id,name,created_at,parent_folder_id,sort_order FROM container_folders")
        .all(),
    ).toEqual([
      {
        id: "folder",
        name: "Representative folder",
        created_at: 1,
        parent_folder_id: null,
        sort_order: 0,
      },
    ]);
    expect(
      preview
        .query("SELECT id,name,created_at,sort_order,folder_id,discipline FROM containers")
        .all(),
    ).toEqual([
      {
        id: "canvas",
        name: "Representative canvas",
        created_at: 2,
        sort_order: 0,
        folder_id: "folder",
        discipline: "canvas",
      },
    ]);
    expect(
      preview.query("SELECT container_id,epoch,rev,ts,hash,hex(doc) AS doc FROM scene_docs").all(),
    ).toEqual([
      { container_id: "canvas", epoch: "epoch", rev: 1, ts: 3, hash: "scene-hash", doc: "010203" },
    ]);
    for (const table of ["principals", "tokens", "grants", "dials"])
      expect(
        preview.query<{ total: number }, []>(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total,
      ).toBe(0);
    expect(preview.query("SELECT key,value FROM meta WHERE key <> 'schema_version'").all()).toEqual(
      [],
    );
    expect(preview.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    });
    expect(
      preview
        .query<{ total: number }, []>(
          "SELECT COUNT(*) AS total FROM plugin_kv WHERE plugin_id = 'example.secret'",
        )
        .get()?.total,
    ).toBe(0);
    expect(
      preview.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM future_authority").get()
        ?.total,
    ).toBe(0);
    expect(preview.query("SELECT future_authority FROM containers").all()).toEqual([
      { future_authority: null },
    ]);
    preview.close();
    const bytes = readFileSync(destinationPath);
    expect(bytes.includes(Buffer.from("development-dial-secret"))).toBeFalse();
    expect(bytes.includes(Buffer.from("development-plugin-secret"))).toBeFalse();
    expect(bytes.includes(Buffer.from("development-signing-key"))).toBeFalse();
    expect(bytes.includes(Buffer.from("future-table-authority-sentinel"))).toBeFalse();
    expect(bytes.includes(Buffer.from("future-column-authority-sentinel"))).toBeFalse();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preview seed refuses an existing destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-preview-seed-"));
  try {
    const sourcePath = join(directory, "source.db");
    const destinationPath = join(directory, "preview.db");
    openDatabase(sourcePath).close();
    writeFileSync(destinationPath, "incumbent");
    expect(() => createPreviewSeed(sourcePath, destinationPath)).toThrow(
      "preview seed destination already exists",
    );
    expect(readFileSync(destinationPath, "utf8")).toBe("incumbent");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
