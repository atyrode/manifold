#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";

interface VersionRow {
  value: string;
}
interface TableRow {
  name: string;
}
interface FolderRow {
  id: string;
  name: string;
  created_at: number;
  parent_folder_id: string | null;
  sort_order: number;
}
interface ContainerRow {
  id: string;
  name: string;
  created_at: number;
  sort_order: number;
  folder_id: string | null;
  discipline: string;
}
interface SceneRow {
  container_id: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  doc: Uint8Array;
}
interface CheckRow {
  integrity_check: string;
}

const quotedIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quotedLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Projects a sensitive hub database into the complete, explicit representative preview seed.
 * A consistent SQLite copy supplies the current schema, then every table is emptied and only
 * these named columns are restored. New tables or columns therefore remain empty or fail closed.
 * The final VACUUM removes deleted authority bytes from the destination file's free pages.
 */
export function createPreviewSeed(sourcePath: string, destinationPath: string): void {
  if (existsSync(destinationPath)) throw new Error("preview seed destination already exists");
  const source = new Database(sourcePath, { readonly: true, strict: true });
  try {
    source.exec(`VACUUM INTO ${quotedLiteral(destinationPath)}`);
  } catch (error) {
    source.close();
    rmSync(destinationPath, { force: true });
    throw error;
  }
  source.close();

  const destination = new Database(destinationPath, { strict: true });
  try {
    const version = destination
      .query<VersionRow, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    if (version === null || !/^[1-9][0-9]*$/.test(version.value)) {
      throw new Error("preview seed source has no supported schema version");
    }
    const folders = destination
      .query<FolderRow, []>(
        "SELECT id, name, created_at, parent_folder_id, sort_order FROM container_folders ORDER BY parent_folder_id, sort_order, id",
      )
      .all();
    const containers = destination
      .query<ContainerRow, []>(
        "SELECT id, name, created_at, sort_order, folder_id, discipline FROM containers ORDER BY folder_id, sort_order, id",
      )
      .all();
    const scenes = destination
      .query<SceneRow, []>(
        "SELECT container_id, epoch, rev, ts, hash, doc FROM scene_docs ORDER BY container_id, epoch, rev",
      )
      .all();
    const tables = destination
      .query<TableRow, []>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();

    destination.exec("PRAGMA foreign_keys = OFF");
    const insertFolder = destination.query<void, [string, string, number, string | null, number]>(
      "INSERT INTO container_folders(id, name, created_at, parent_folder_id, sort_order) VALUES (?, ?, ?, ?, ?)",
    );
    const insertContainer = destination.query<
      void,
      [string, string, number, number, string | null, string]
    >(
      "INSERT INTO containers(id, name, created_at, sort_order, folder_id, discipline) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertScene = destination.query<
      void,
      [string, string, number, number, string, Uint8Array]
    >("INSERT INTO scene_docs(container_id, epoch, rev, ts, hash, doc) VALUES (?, ?, ?, ?, ?, ?)");
    destination.transaction(() => {
      for (const table of tables) destination.exec(`DELETE FROM ${quotedIdentifier(table.name)}`);
      destination
        .query("INSERT INTO meta(key, value) VALUES ('schema_version', ?)")
        .run(version.value);
      for (const row of folders)
        insertFolder.run(row.id, row.name, row.created_at, row.parent_folder_id, row.sort_order);
      for (const row of containers)
        insertContainer.run(
          row.id,
          row.name,
          row.created_at,
          row.sort_order,
          row.folder_id,
          row.discipline,
        );
      for (const row of scenes)
        insertScene.run(row.container_id, row.epoch, row.rev, row.ts, row.hash, row.doc);
    })();

    const integrity = destination.query<CheckRow, []>("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error("preview seed integrity check failed");
    if (
      destination.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0
    )
      throw new Error("preview seed foreign key check failed");
    destination.exec("PRAGMA journal_mode = DELETE");
    destination.exec("VACUUM");
  } catch (error) {
    destination.close();
    rmSync(destinationPath, { force: true });
    throw error;
  }
  destination.close();
}

if (import.meta.main) {
  const [source, destination, ...extra] = process.argv.slice(2);
  if (source === undefined || destination === undefined || extra.length !== 0) {
    throw new Error("usage: preview-seed.ts <source-database> <destination-database>");
  }
  createPreviewSeed(source, destination);
  console.log("preview-seed: containers, container_folders and scene_docs only");
}
