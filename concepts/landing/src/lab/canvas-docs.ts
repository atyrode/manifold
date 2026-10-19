// Documents kept in this browser and moved as files (the lab's canvas mode, src/engine/README.md: a
// setup is a document, never a URL query). The browser keeps them under DOCS_KEY as one versioned
// record; every read validates it, keeping each well-formed document and dropping what is not one.
// A file is the document itself as JSON (EngineDoc, `v` its version). A document read from a file
// is checked against the kinds on offer too: one naming a kind this build does not have, or holding
// more of a kind than it allows, is refused with the reason.
import type { EngineCamera, EngineDoc, KindDef, Placed, Vec3 } from "../engine/types.ts";

/** Where this browser keeps its documents. */
export const DOCS_KEY = "landing.docs";
/** The stored record's version: a record of another is not read. */
export const DOCS_VERSION = 1;

/** A document saved in this browser, under its name. */
export interface SavedDoc {
  readonly name: string;
  /** When it was last saved, milliseconds since the epoch. */
  readonly savedAt: number;
  readonly doc: EngineDoc;
}

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function vec3(value: unknown, what: string): Parsed<Vec3> {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite))
    return { ok: false, why: `${what} is not three numbers` };
  const [x, y, z] = value as [number, number, number];
  return { ok: true, value: [x, y, z] };
}

function numbers(value: unknown, what: string): Parsed<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, why: `${what} is not a table of numbers` };
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!finite(entry)) return { ok: false, why: `${what} "${key}" is not a number` };
    out[key] = entry;
  }
  return { ok: true, value: out };
}

function camera(value: unknown): Parsed<EngineCamera> {
  if (typeof value !== "object" || value === null) return { ok: false, why: "it has no camera" };
  const { at, yaw, pitch, fov } = value as Partial<Record<keyof EngineCamera, unknown>>;
  const eye = vec3(at, "the camera's place");
  if (!eye.ok) return eye;
  if (!finite(yaw) || !finite(pitch))
    return { ok: false, why: "the camera's turn is not a number" };
  if (!finite(fov) || fov <= 0 || fov >= Math.PI)
    return { ok: false, why: "the camera's field of view is not an angle between 0 and π" };
  return { ok: true, value: { at: eye.value, yaw, pitch, fov } };
}

function placed(value: unknown, index: number): Parsed<Placed> {
  const what = `object ${index + 1}`;
  if (typeof value !== "object" || value === null) return { ok: false, why: `${what} is not one` };
  const { id, kind, at, yaw, scale, options } = value as Partial<Record<keyof Placed, unknown>>;
  if (typeof id !== "string" || id === "") return { ok: false, why: `${what} has no id` };
  if (typeof kind !== "string" || kind === "") return { ok: false, why: `${what} has no kind` };
  const place = vec3(at, `${what}'s place`);
  if (!place.ok) return place;
  if (!finite(yaw)) return { ok: false, why: `${what}'s turn is not a number` };
  if (!finite(scale) || scale <= 0) return { ok: false, why: `${what}'s scale is not above 0` };
  const values = numbers(options ?? {}, `${what}'s option`);
  if (!values.ok) return values;
  return { ok: true, value: { id, kind, at: place.value, yaw, scale, options: values.value } };
}

/**
 * `value` as a document, rebuilt from its own fields alone, or why it is none: its version, title,
 * camera, World knobs and objects (unique ids) each of the right shape; with `kinds`, every object
 * of a kind on offer, and no kind held more often than it allows (`max`, one of an exclusive group).
 */
export function parseDoc(
  value: unknown,
  kinds?: readonly KindDef[],
): { readonly doc: EngineDoc } | { readonly why: string } {
  if (typeof value !== "object" || value === null) return { why: "It is not a document." };
  const fields = value as Partial<Record<keyof EngineDoc, unknown>>;
  if (fields.v !== 1) return { why: `It is a document of version ${String(fields.v)}, not 1.` };
  if (typeof fields.title !== "string") return { why: "It has no title." };
  const title = fields.title;
  const eye = camera(fields.camera);
  if (!eye.ok) return { why: `In it, ${eye.why}.` };
  const world = numbers(fields.world ?? {}, "the World's knob");
  if (!world.ok) return { why: `In it, ${world.why}.` };
  if (!Array.isArray(fields.objects)) return { why: "It has no list of objects." };
  const objects: Placed[] = [];
  for (const [at, entry] of fields.objects.entries()) {
    const object = placed(entry, at);
    if (!object.ok) return { why: `In it, ${object.why}.` };
    if (objects.some((other) => other.id === object.value.id))
      return { why: `Two of its objects share the id "${object.value.id}".` };
    objects.push(object.value);
  }
  if (kinds) {
    const unknown = [...new Set(objects.map((object) => object.kind))].filter(
      (kind) => !kinds.some((candidate) => candidate.id === kind),
    );
    if (unknown.length > 0)
      return {
        why: `This build has no kind ${unknown.map((kind) => `"${kind}"`).join(", ")}: its ${unknown.length === 1 ? "object" : "objects"} cannot be shown.`,
      };
    for (const kind of kinds) {
      const count = objects.filter((object) => object.kind === kind.id).length;
      if (count > kind.max)
        return { why: `It holds ${count} of ${kind.title.toLowerCase()}, more than ${kind.max}.` };
    }
    const groups = new Map<string, number>();
    for (const object of objects) {
      const group = kinds.find((kind) => kind.id === object.kind)?.exclusive;
      if (group !== undefined) groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    for (const [group, count] of groups)
      if (count > 1) return { why: `It holds ${count} of one ${group}, where one is allowed.` };
  }
  return { doc: { v: 1, title, camera: eye.value, world: world.value, objects } };
}

/**
 * The documents a stored record holds (null: none stored): every well-formed one, in the order
 * saved; a record of another version, or not one at all, holds none.
 */
export function readDocs(raw: string | null): SavedDoc[] {
  if (raw === null) return [];
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof record !== "object" || record === null) return [];
  const { v, docs } = record as { v?: unknown; docs?: unknown };
  if (v !== DOCS_VERSION || !Array.isArray(docs)) return [];
  const out: SavedDoc[] = [];
  for (const entry of docs) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, savedAt, doc } = entry as Partial<Record<keyof SavedDoc, unknown>>;
    if (typeof name !== "string" || name.trim() === "" || !finite(savedAt)) continue;
    const parsed = parseDoc(doc);
    if (!("doc" in parsed) || out.some((saved) => saved.name === name)) continue;
    out.push({ name, savedAt, doc: parsed.doc });
  }
  return out;
}

/** `docs` as the stored record. */
export function writeDocs(docs: readonly SavedDoc[]): string {
  return JSON.stringify({ v: DOCS_VERSION, docs });
}

/** `docs` with `doc` saved as `name` at `now`: in its place over one of that name, else last. */
export function saveDoc(
  docs: readonly SavedDoc[],
  name: string,
  doc: EngineDoc,
  now: number,
): SavedDoc[] {
  const saved: SavedDoc = { name, savedAt: now, doc };
  const at = docs.findIndex((entry) => entry.name === name);
  return at < 0 ? [...docs, saved] : docs.map((entry, index) => (index === at ? saved : entry));
}

/** `docs` without the one named `name`. */
export function deleteDoc(docs: readonly SavedDoc[], name: string): SavedDoc[] {
  return docs.filter((entry) => entry.name !== name);
}

/** A document read from a file's text, against the kinds on offer; or why it cannot be. */
export function importDoc(
  text: string,
  kinds: readonly KindDef[],
): { readonly doc: EngineDoc } | { readonly why: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { why: "The file is not JSON." };
  }
  return parseDoc(value, kinds);
}

/** A document as a file: its JSON, and a file name from its title. */
export function exportDoc(doc: EngineDoc): { readonly name: string; readonly text: string } {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return { name: `${slug || "document"}.json`, text: `${JSON.stringify(doc, null, 2)}\n` };
}

/** The documents saved in this browser. */
export function loadSavedDocs(): SavedDoc[] {
  return readDocs(localStorage.getItem(DOCS_KEY));
}

/** Keep `docs` as the documents saved in this browser. */
export function storeSavedDocs(docs: readonly SavedDoc[]): void {
  localStorage.setItem(DOCS_KEY, writeDocs(docs));
}
