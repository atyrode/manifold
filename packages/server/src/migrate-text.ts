import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { SharedTextRecordSchema, formatManifoldUri } from "@manifold/protocol";
import { ELEMENTS_KEY, Y } from "@manifold/scene";
import { executeMigrationStatements } from "./migration-statements.ts";

const OLD_OWNER = "core.notes";
const TEXT_OWNER = "core.text";
const NOTE_OWNER = "core.canvas.note";
const TEXTS = "texts";
const AUTHORSHIP = ["lastEditedBy", "lastEditedAt"] as const;

/** Whole capacity DDL statements, including the trigger body, for the prepared runner. */
const CAPACITY_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS scene_doc_capacity(
      container_id TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      epoch TEXT NOT NULL,
      migration_bytes INTEGER NOT NULL CHECK(migration_bytes >= 0),
      PRIMARY KEY(container_id, epoch)
    )`,
  `CREATE TRIGGER IF NOT EXISTS scene_doc_capacity_retire
      AFTER DELETE ON scene_docs
      WHEN NOT EXISTS (SELECT 1 FROM scene_docs
        WHERE container_id = OLD.container_id AND epoch = OLD.epoch)
      BEGIN
        DELETE FROM scene_doc_capacity WHERE container_id = OLD.container_id AND epoch = OLD.epoch;
      END`,
];

interface SceneRow {
  container_id: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  doc: Uint8Array;
}
interface ElementIdentity {
  id: string;
  root: Y.ID;
}
interface Lineage {
  home: string;
  epoch: string;
  canvas: boolean;
  authors: Set<number>;
  elements: Map<string, ElementIdentity>;
}

function refuse(input: string, reason: string): never {
  throw new Error(`text ownership migration: ${input}: ${reason}`);
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function idKey(id: Y.ID): string {
  return `${id.client}:${id.clock}`;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** No clocks are borrowed from a real author. Allocation sees ALL retained source clients. */
class SyntheticClients {
  private readonly allocated = new Map<string, number>();
  private readonly facts = new Map<string, string>();
  private readonly generated = new Set<number>();
  // Yjs 13.6.32 generates uint32 authors, but its V1 client codec accepts safe integers.
  // Keep synthetic writers outside that range, including offline authors not in a snapshot.
  private next = 0x1_0000_0000;
  constructor(private readonly used: Set<number>) {}
  get(key: string): number {
    const previous = this.allocated.get(key);
    if (previous !== undefined) return previous;
    while (this.used.has(this.next)) this.next += 1;
    if (!Number.isSafeInteger(this.next)) refuse("codec", "synthetic client namespace exhausted");
    const candidate = this.next++;
    this.used.add(candidate);
    this.generated.add(candidate);
    this.allocated.set(key, candidate);
    return candidate;
  }
  remember(key: string, fact: string): void {
    // Retain fixed-size identity evidence, not every historical scalar body.
    fact = createHash("sha256").update(fact).digest("hex");
    const previous = this.facts.get(key);
    if (previous !== undefined && previous !== fact) {
      refuse("codec", `inconsistent retained CRDT identity ${key}`);
    }
    this.facts.set(key, fact);
  }
  finish(doc: Y.Doc): void {
    for (const [client, structs] of doc.store.clients) {
      if (!this.generated.has(client)) continue;
      structs.sort((left, right) => left.id.clock - right.id.clock);
      const complete: (Y.Item | Y.GC)[] = [];
      let clock = 0;
      for (const item of structs) {
        if (item.id.clock < clock) refuse("codec", "overlapping synthetic clock ranges");
        if (item.id.clock > clock)
          complete.push(new Y.GC(Y.createID(client, clock), item.id.clock - clock));
        complete.push(item);
        clock = item.id.clock + item.length;
      }
      doc.store.clients.set(client, complete);
    }
  }
}

function chain(map: Y.Map<unknown>, key: string): Y.Item[] {
  const result: Y.Item[] = [];
  for (
    let item: Y.Item | null | undefined = map._map.get(key);
    item !== undefined && item !== null;
    item = item.left
  ) {
    if (
      item.parent !== map ||
      item.parentSub !== key ||
      (item.length !== 1 && !(item.deleted && item.content instanceof Y.ContentDeleted))
    ) {
      refuse(key, "unsupported map history");
    }
    result.push(item);
  }
  return result;
}

function validateBody(body: unknown, where: string): string {
  if (typeof body === "string") return body;
  if (!(body instanceof Y.Text) || body instanceof Y.XmlText) {
    return refuse(where, "inline body is neither a string nor Y.Text");
  }
  for (const part of body.toDelta()) {
    if (typeof part.insert !== "string") refuse(where, "embedded text values are unsupported");
  }
  return body.toString();
}

function readLineages(db: Database, clients: Set<number>): Lineage[] {
  const homes = new Map(
    db
      .query<{ id: string; discipline: string }, []>("SELECT id, discipline FROM containers")
      .all()
      .map((row) => [row.id, row.discipline]),
  );
  const lineages = new Map<string, Lineage>();
  for (const row of db
    .query<SceneRow, []>(
      "SELECT container_id, epoch, rev, ts, hash, doc FROM scene_docs ORDER BY container_id, epoch, rev",
    )
    .iterate()) {
    // Hash mismatches and undecodable updates remain byte-for-byte corrupt evidence.
    if (hash(row.doc) !== row.hash) continue;
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, row.doc);
    } catch {
      doc.destroy();
      continue;
    }
    const key = JSON.stringify([row.container_id, row.epoch]);
    let lineage = lineages.get(key);
    if (lineage === undefined) {
      lineage = {
        home: row.container_id,
        epoch: row.epoch,
        canvas: homes.get(row.container_id) === "canvas",
        authors: new Set(),
        elements: new Map(),
      };
      lineages.set(key, lineage);
    }
    try {
      if (!homes.has(row.container_id)) refuse(key, "scene has no authority home");
      if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
        refuse(key, "retained update is not a closed snapshot");
      }
      for (const client of doc.store.clients.keys()) {
        clients.add(client);
        lineage.authors.add(client);
      }
      const texts = doc.getMap<unknown>(TEXTS);
      if (texts._start !== null) refuse(key, "texts root is not a map");
      for (const recordKey of texts._map.keys()) {
        if (recordKey.startsWith(`${TEXT_OWNER}:`))
          refuse(key, `occupied text namespace ${recordKey}`);
      }
      const elements = doc.getMap<unknown>(ELEMENTS_KEY);
      if (elements._start !== null) refuse(key, "elements root is not a map");
      for (const [id, value] of elements) {
        if (!(value instanceof Y.Map)) refuse(`${key}/${id}`, "element is not a map");
        if (value.get("type") === "canvas_note")
          refuse(`${key}/${id}`, "occupied canvas_note kind");
        if (value.get("type") !== "text") continue;
        if (value._item === null || value.get("id") !== id)
          refuse(`${key}/${id}`, "inconsistent element identity");
        if (value._map.has("document")) refuse(`${key}/${id}`, "occupied document payload field");
        const parsed = SharedTextRecordSchema.safeParse({
          namespace: TEXT_OWNER,
          id,
          text: validateBody(value.get("text"), `${key}/${id}`),
          ...(value.has("lastEditedBy") ? { lastEditedBy: value.get("lastEditedBy") } : {}),
          ...(value.has("lastEditedAt") ? { lastEditedAt: value.get("lastEditedAt") } : {}),
        });
        if (!parsed.success) refuse(`${key}/${id}`, "invalid body bounds or attribution");
        const previous = lineage.elements.get(idKey(value._item.id));
        if (previous !== undefined && previous.id !== id)
          refuse(key, "inconsistent retained element-root identity");
        lineage.elements.set(idKey(value._item.id), { id, root: value._item.id });
      }
    } finally {
      doc.destroy();
    }
  }
  return [...lineages.values()];
}

function append(doc: Y.Doc, item: Y.Item, clients: SyntheticClients): void {
  const parent = item.parent;
  const parentKey =
    parent instanceof Y.ID
      ? idKey(parent)
      : parent instanceof Y.AbstractType
        ? parent._item === null
          ? `root:${Y.findRootTypeKey(parent)}`
          : idKey(parent._item.id)
        : refuse("codec", "synthetic item has no parent");
  const key = `synthetic/${idKey(item.id)}`;
  clients.remember(
    `${key}/position`,
    JSON.stringify([parentKey, item.parentSub, item.origin, item.rightOrigin]),
  );
  // Garbage collection may erase a value, but may not assign its identity another value.
  if (!(item.content instanceof Y.ContentDeleted)) {
    const value =
      item.content instanceof Y.ContentAny
        ? item.content.arr
        : item.content instanceof Y.ContentString
          ? item.content.str
          : item.content instanceof Y.ContentType && item.content.type instanceof Y.Map
            ? "Y.Map"
            : refuse("codec", "unsupported synthetic content");
    clients.remember(`${key}/content`, JSON.stringify([item.content.getRef(), value]));
  }
  const structs = doc.store.clients.get(item.id.client);
  if (structs === undefined) doc.store.clients.set(item.id.client, [item]);
  else structs.push(item);
}

/**
 * CLOSED-SNAPSHOT codec, pinned to Yjs 13.6.32's Item/ContentType representation.
 * Never run this against a Room. Item.write encodes parent from _item (or the root name),
 * except when an origin supplies it. Consequently the WHOLE map-key chain is reparented.
 * We serialize immediately and reopen with the ordinary Yjs decoder; no live caches,
 * transactions, observers, or alternative sync implementation use the temporary graph.
 */
function convert(lineage: Lineage, doc: Y.Doc, clients: SyntheticClients): Uint8Array {
  const prefix = JSON.stringify(["schema52", lineage.home, lineage.epoch]);
  const mappedId = (kind: string, id: Y.ID): Y.ID =>
    Y.createID(clients.get(`${prefix}/${kind}/${id.client}`), id.clock);
  const elements = doc.getMap<unknown>(ELEMENTS_KEY);
  const ids = new Set([...lineage.elements.values()].map((identity) => identity.id));
  for (const id of ids) {
    // Mirror every generation at this key, but only original text roots own live records.
    // Non-text roots are deleted ordering markers; the original elements remain untouched.
    // Coalesced tombstones keep their whole original clock range, never one fake clock.
    for (const source of chain(elements, id)) {
      const identity = lineage.elements.get(idKey(source.id));
      if (identity !== undefined && identity.id !== id)
        refuse(lineage.home, "inconsistent retained element-root identity");
      clients.remember(
        `${prefix}/root/${idKey(source.id)}`,
        JSON.stringify([id, source.origin, source.rightOrigin]),
      );
      const live = !source.deleted && identity !== undefined;
      const record = new Y.Map<unknown>();
      const recordItem = new Y.Item(
        mappedId("roots", source.id),
        null,
        source.origin === null ? null : mappedId("roots", source.origin),
        null,
        source.rightOrigin === null ? null : mappedId("roots", source.rightOrigin),
        doc.getMap(TEXTS),
        `${TEXT_OWNER}:${id}`,
        live ? new Y.ContentType(record) : new Y.ContentDeleted(source.length),
      );
      if (!live) recordItem.markDeleted();
      record._item = recordItem;
      append(doc, recordItem, clients);
      if (!live) continue;
      const element = source.content instanceof Y.ContentType ? source.content.type : null;
      if (!(element instanceof Y.Map)) refuse(lineage.home, "lost element map identity");
      const token = `${prefix}/constants/${idKey(source.id)}`;
      const client = clients.get(token);
      append(
        doc,
        new Y.Item(
          Y.createID(client, 0),
          null,
          null,
          null,
          null,
          record,
          "namespace",
          new Y.ContentAny([TEXT_OWNER]),
        ),
        clients,
      );
      append(
        doc,
        new Y.Item(
          Y.createID(client, 1),
          null,
          null,
          null,
          null,
          record,
          "id",
          new Y.ContentAny([id]),
        ),
        clients,
      );
      append(
        doc,
        new Y.Item(
          Y.createID(client, 2),
          null,
          null,
          null,
          null,
          source.id,
          "document",
          new Y.ContentAny([JSON.stringify([lineage.home, id])]),
        ),
        clients,
      );
      for (const item of chain(element, "text")) {
        item.parent = record;
        if (item.content instanceof Y.ContentAny) {
          const value: unknown = item.content.arr[0];
          if (typeof value !== "string") refuse(token, "historical inline body is not text");
          clients.remember(`${prefix}/body/${idKey(item.id)}`, JSON.stringify(["string", value]));
          // Keep the scalar's map Item; only its immutable character stream is synthesized.
          const body = new Y.Text();
          body._item = item;
          item.content = new Y.ContentType(body);
          if (value.length !== 0) {
            const chars = new Y.Item(
              Y.createID(clients.get(`${prefix}/string/${idKey(item.id)}`), 0),
              null,
              null,
              null,
              null,
              body,
              null,
              new Y.ContentString(value),
            );
            if (item.deleted) chars.markDeleted();
            append(doc, chars, clients);
          }
        } else if (item.content instanceof Y.ContentType) {
          validateBody(item.content.type, token);
          clients.remember(`${prefix}/body/${idKey(item.id)}`, "Y.Text");
        } else if (!(item.content instanceof Y.ContentDeleted)) {
          refuse(token, "unsupported historical body content");
        }
      }
      if (lineage.canvas) {
        for (const item of chain(element, "type")) {
          if (item.content instanceof Y.ContentAny && item.content.arr[0] === "text") {
            item.content = new Y.ContentAny(["canvas_note"]);
          }
        }
      }
      for (const field of AUTHORSHIP) {
        for (const sourceItem of chain(element, field)) {
          if (
            !(sourceItem.content instanceof Y.ContentAny) &&
            !(sourceItem.content instanceof Y.ContentDeleted)
          ) {
            refuse(`${lineage.home}/${id}`, "unsupported historical attribution");
          }
          const copy = new Y.Item(
            mappedId(field, sourceItem.id),
            null,
            sourceItem.origin === null ? null : mappedId(field, sourceItem.origin),
            null,
            sourceItem.rightOrigin === null ? null : mappedId(field, sourceItem.rightOrigin),
            record,
            field,
            sourceItem.content.copy(),
          );
          if (sourceItem.deleted) copy.markDeleted();
          append(doc, copy, clients);
        }
      }
    }
  }
  clients.finish(doc);
  const bytes = Y.encodeStateAsUpdate(doc);
  const probe = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(probe, bytes);
    if (probe.store.pendingStructs !== null || probe.store.pendingDs !== null) {
      refuse(lineage.home, "transformed snapshot has unresolved dependencies");
    }
    for (const identity of lineage.elements.values()) {
      const element = probe.getMap<unknown>(ELEMENTS_KEY).get(identity.id);
      if (
        !(element instanceof Y.Map) ||
        element._item === null ||
        !Y.compareIDs(element._item.id, identity.root)
      )
        continue;
      const record = probe.getMap<unknown>(TEXTS).get(`${TEXT_OWNER}:${identity.id}`);
      if (
        !(record instanceof Y.Map) ||
        !(record.get("text") instanceof Y.Text) ||
        element.has("text")
      ) {
        refuse(lineage.home, "transformed body identity is unreachable");
      }
    }
    return bytes;
  } finally {
    probe.destroy();
  }
}

interface MetadataPlan {
  writes: Map<string, string>;
  ownerNamespaces: string[];
}
function metadataPlan(db: Database, hasText: boolean): MetadataPlan {
  const read = (key: string): unknown => {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    if (row === null) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return refuse(key, "invalid persisted JSON");
    }
  };
  const disabledRaw = read("plugins:disabled") ?? [];
  const attribution = read("plugins:attribution") ?? {};
  const owners = read("plugins:element-owners") ?? {};
  if (
    !Array.isArray(disabledRaw) ||
    !disabledRaw.every((id): id is string => typeof id === "string")
  ) {
    refuse("plugins:disabled", "invalid disabled state");
  }
  if (
    !object(attribution) ||
    !object(owners) ||
    !Object.values(owners).every((value) => typeof value === "string")
  ) {
    refuse("plugins", "invalid attribution or ownership state");
  }
  for (const [id, value] of Object.entries(attribution)) {
    if (
      !object(value) ||
      typeof value.by !== "string" ||
      value.by.length === 0 ||
      typeof value.at !== "number" ||
      !Number.isInteger(value.at) ||
      value.at < 0
    ) {
      refuse(id, "invalid enablement attribution");
    }
  }
  const disabled = new Set(disabledRaw);
  for (const target of [TEXT_OWNER, NOTE_OWNER]) {
    if (
      disabled.has(target) ||
      Object.hasOwn(attribution, target) ||
      Object.values(owners).includes(target) ||
      db.query("SELECT 1 FROM plugin_kv WHERE plugin_id = ? LIMIT 1").get(target) !== null
    ) {
      refuse(target, "occupied target namespace, state or reservation");
    }
  }
  if (
    Object.hasOwn(owners, "canvas_note") ||
    (owners.text !== undefined && owners.text !== OLD_OWNER)
  ) {
    refuse("element owners", "occupied text/canvas_note reservation");
  }
  const reservations = db
    .query<{ plugin_id: string; key: string; value: string }, []>(
      "SELECT plugin_id, key, value FROM plugin_kv WHERE plugin_id GLOB 'engine.*' AND key GLOB '$owner:*'",
    )
    .all();
  for (const row of reservations) {
    if (
      row.key === "$owner:canvas_note" ||
      (row.key === "$owner:text" && row.value !== OLD_OWNER) ||
      row.value === TEXT_OWNER ||
      row.value === NOTE_OWNER
    ) {
      refuse(`${row.plugin_id}/${row.key}`, "occupied legacy ownership reservation");
    }
  }
  // Executable artifacts or prepared private-database images require their pinned identity
  // and filesystem manifest to agree. They are not a native built-in rename. Historical
  // jobs, receipts, decisions and audit payloads instead stay verbatim as historical facts.
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  for (const { name } of tables) {
    if (
      name !== "plugin_installs" &&
      name !== "plugin_database_journal" &&
      name !== "machine_job_installs" &&
      name !== "native_instance_services"
    )
      continue;
    if (
      db
        .query(`SELECT 1 FROM "${name.replaceAll('"', '""')}" WHERE plugin_id IN (?, ?, ?) LIMIT 1`)
        .get(OLD_OWNER, TEXT_OWNER, NOTE_OWNER) !== null
    ) {
      refuse(
        name,
        "native text identity occupies an executable artifact or prepared database image",
      );
    }
  }
  if (
    !hasText &&
    !disabled.has(OLD_OWNER) &&
    !disabled.has("core.canvas") &&
    !Object.hasOwn(attribution, OLD_OWNER) &&
    !Object.hasOwn(attribution, "core.canvas") &&
    !Object.values(owners).includes(OLD_OWNER) &&
    !reservations.some((row) => row.value === OLD_OWNER) &&
    db.query("SELECT 1 FROM plugin_kv WHERE plugin_id = ? LIMIT 1").get(OLD_OWNER) === null
  ) {
    return { writes: new Map(), ownerNamespaces: [] };
  }
  const writes = new Map<string, string>();
  if (disabled.delete(OLD_OWNER)) disabled.add(TEXT_OWNER);
  if (disabled.has(TEXT_OWNER) || disabled.has("core.canvas")) disabled.add(NOTE_OWNER);
  const cause = disabled.has(TEXT_OWNER)
    ? OLD_OWNER
    : disabled.has("core.canvas")
      ? "core.canvas"
      : OLD_OWNER;
  if (Object.hasOwn(attribution, cause)) attribution[NOTE_OWNER] = attribution[cause];
  if (Object.hasOwn(attribution, OLD_OWNER)) {
    attribution[TEXT_OWNER] = attribution[OLD_OWNER];
    delete attribution[OLD_OWNER];
  }
  for (const [kind, owner] of Object.entries(owners))
    if (owner === OLD_OWNER) owners[kind] = TEXT_OWNER;
  owners.text = TEXT_OWNER;
  owners.canvas_note = NOTE_OWNER;
  writes.set("plugins:disabled", JSON.stringify([...disabled].sort()));
  writes.set("plugins:attribution", JSON.stringify(attribution));
  writes.set("plugins:element-owners", JSON.stringify(owners));
  return {
    writes,
    ownerNamespaces: [
      ...new Set(
        reservations.filter((row) => row.key === "$owner:text").map((row) => row.plugin_id),
      ),
    ],
  };
}

/** Schema 52; the global runner supplies the complete backup and enclosing transaction. */
export function migrateToOwnedText(db: Database, _path: string): void {
  const clients = new Set<number>();
  const lineages = readLineages(db, clients);
  const plan = metadataPlan(
    db,
    lineages.some((lineage) => lineage.elements.size !== 0),
  );
  // A server-owned capacity fact, never a client-writable CRDT field. Updates cannot
  // mint credit, and another epoch cannot inherit it.
  executeMigrationStatements(db, CAPACITY_STATEMENTS);
  const allocator = new SyntheticClients(clients);
  for (const lineage of lineages) {
    const prefix = JSON.stringify(["schema52", lineage.home, lineage.epoch]);
    for (const client of [...lineage.authors].sort((left, right) => left - right)) {
      for (const kind of ["roots", ...AUTHORSHIP]) allocator.get(`${prefix}/${kind}/${client}`);
    }
  }
  const write = db.query(
    "UPDATE scene_docs SET doc = ?, hash = ? WHERE container_id = ? AND epoch = ? AND rev = ?",
  );
  const revisions = db.query<SceneRow, [string, string]>(
    "SELECT container_id, epoch, rev, ts, hash, doc FROM scene_docs WHERE container_id = ? AND epoch = ? ORDER BY rev",
  );
  // Two passes retain identity indexes, but only one source graph plus its validation
  // probe and encoded blobs at a time. The enclosing transaction is the staging area.
  for (const lineage of lineages) {
    if (lineage.elements.size === 0) continue;
    let overhead = 0;
    for (const row of revisions.iterate(lineage.home, lineage.epoch)) {
      if (hash(row.doc) !== row.hash) continue;
      const doc = new Y.Doc({ gc: false });
      try {
        try {
          Y.applyUpdate(doc, row.doc);
        } catch {
          continue;
        }
        const bytes = convert(lineage, doc, allocator);
        overhead = Math.max(overhead, bytes.byteLength - row.doc.byteLength);
        write.run(bytes, hash(bytes), row.container_id, row.epoch, row.rev);
      } finally {
        doc.destroy();
      }
    }
    if (overhead > 0) {
      db.query(
        "INSERT INTO scene_doc_capacity(container_id, epoch, migration_bytes) VALUES (?, ?, ?)",
      ).run(lineage.home, lineage.epoch, overhead);
    }
  }
  db.query("UPDATE plugin_kv SET plugin_id = ? WHERE plugin_id = ?").run(TEXT_OWNER, OLD_OWNER);
  db.query(
    "UPDATE plugin_kv SET value = ? WHERE plugin_id GLOB 'engine.*' AND key GLOB '$owner:*' AND value = ?",
  ).run(TEXT_OWNER, OLD_OWNER);
  for (const namespace of plan.ownerNamespaces) {
    db.query(
      "INSERT INTO plugin_kv(plugin_id, key, value) VALUES (?, '$owner:canvas_note', ?)",
    ).run(namespace, NOTE_OWNER);
  }
  for (const [key, value] of plan.writes) {
    db.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  }
  // These are live addresses, unlike journal payloads or opaque private plugin values.
  const oldNode = formatManifoldUri({ kind: "plugin", pluginId: OLD_OWNER });
  const newNode = formatManifoldUri({ kind: "plugin", pluginId: TEXT_OWNER });
  db.query("UPDATE grants SET node = ? WHERE node = ?").run(newNode, oldNode);
  for (const row of db
    .query<{ id: string; ref: string }, []>("SELECT id, ref FROM dials WHERE ref IS NOT NULL")
    .all()) {
    let value: unknown;
    try {
      value = JSON.parse(row.ref) as unknown;
    } catch {
      continue;
    }
    if (object(value) && value.kind === "plugin" && value.pluginId === OLD_OWNER) {
      db.query("UPDATE dials SET ref = ? WHERE id = ?").run(
        JSON.stringify({ ...value, pluginId: TEXT_OWNER }),
        row.id,
      );
    } else if (value === oldNode) {
      db.query("UPDATE dials SET ref = ? WHERE id = ?").run(JSON.stringify(newNode), row.id);
    }
  }
  db.query("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '52')").run();
}
