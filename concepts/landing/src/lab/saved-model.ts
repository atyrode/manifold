// The Scenes view's Saved list (lab/saved.ts): everything saved in this browser as one list, the
// setups over the scenes (src/presets.ts) and the canvas's documents (lab/canvas-docs.ts), the last
// saved first. They move between browsers as one file: the export holds both, and an import reads
// that file, a document's own file (the canvas's Export), or setups as the lab once exported them
// (a list of presets, or one). A document imported under a name already saved here takes the
// name with a number after it, so an import never overwrites what is here.
import type { KindDef } from "../engine/types.ts";
import { isPreset, type Preset } from "../presets.ts";
import { sceneDefs } from "../scenes/index.ts";
import { parseDoc, saveDoc, type SavedDoc } from "./canvas-docs.ts";
import { presetScene } from "./tree-model.ts";

/** An entry of the Saved list: a setup (its index among those stored) or a document. */
export type SavedItem =
  | { readonly kind: "setup"; readonly preset: Preset; readonly index: number }
  | { readonly kind: "doc"; readonly saved: SavedDoc };

/** The export file's version: a file of another is not read. */
export const SAVED_VERSION = 1;

/** When `item` was saved, milliseconds since the epoch (a setup's day alone: its midnight). */
function savedTime(item: SavedItem): number {
  if (item.kind === "doc") return item.saved.savedAt;
  const time = Date.parse(item.preset.savedAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * The `setups` and `docs` saved here as one list, the last saved first; of two saved at the same
 * time (a setup's day carries no hour), the one stored later first.
 */
export function savedItems(setups: readonly Preset[], docs: readonly SavedDoc[]): SavedItem[] {
  const items: SavedItem[] = [
    ...setups.map((preset, index): SavedItem => ({ kind: "setup", preset, index })),
    ...docs.map((saved): SavedItem => ({ kind: "doc", saved })),
  ];
  return items
    .map((item, order) => ({ item, order, time: savedTime(item) }))
    .sort((a, b) => b.time - a.time || b.order - a.order)
    .map(({ item }) => item);
}

/** The name an entry shows. */
export function savedName(item: SavedItem): string {
  return item.kind === "setup" ? item.preset.name : item.saved.name;
}

/**
 * Whether `item` answers the search `query` (an empty one answers every entry): a setup by its name
 * or its scene's id or title, a document by its name, its title or the kinds it holds.
 */
export function savedMatches(item: SavedItem, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  if (item.kind === "setup") {
    const scene = presetScene(item.preset);
    const words = scene ? `${scene} ${sceneDefs[scene].title}` : "";
    return `setup ${item.preset.name} ${words}`.toLowerCase().includes(text);
  }
  const kinds = item.saved.doc.objects.map((object) => object.kind).join(" ");
  return `canvas document ${item.saved.name} ${item.saved.doc.title} ${kinds}`
    .toLowerCase()
    .includes(text);
}

/** Everything saved here as one file: its name, and its JSON. */
export function exportSaved(
  setups: readonly Preset[],
  docs: readonly SavedDoc[],
): { readonly name: string; readonly text: string } {
  const text = JSON.stringify({ v: SAVED_VERSION, setups, docs }, null, 2);
  return { name: "manifold-saved.json", text: `${text}\n` };
}

/** What a file brings: the setups and the documents it holds. */
export interface SavedImport {
  readonly setups: readonly Preset[];
  readonly docs: readonly { readonly name: string; readonly doc: SavedDoc["doc"] }[];
}

/**
 * What the file's `text` brings (see the header), read against the `kinds` on offer; or why it
 * brings nothing. One document or setup that cannot be read refuses the whole file, with the
 * reason: an import adds all of a file or none of it.
 */
export function readSaved(
  text: string,
  kinds: readonly KindDef[],
): SavedImport | { readonly why: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { why: "The file is not JSON." };
  }
  // Setups as the lab once exported them: a list of presets, or one.
  if (Array.isArray(value) ? value.length > 0 && value.every(isPreset) : isPreset(value))
    return { setups: Array.isArray(value) ? value : [value], docs: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { why: "It holds neither setups nor documents." };
  const record = value as Record<string, unknown>;
  // A document's own file.
  if ("objects" in record) {
    const read = parseDoc(value, kinds);
    if ("why" in read) return { why: read.why };
    return { setups: [], docs: [{ name: read.doc.title.trim() || "Untitled", doc: read.doc }] };
  }
  if (record.v !== SAVED_VERSION)
    return { why: `It is a saved file of version ${String(record.v)}, not ${SAVED_VERSION}.` };
  const setups = record.setups ?? [];
  const docs = record.docs ?? [];
  if (!Array.isArray(setups) || !setups.every(isPreset))
    return { why: "Its setups are not a list of setups." };
  if (!Array.isArray(docs)) return { why: "Its documents are not a list." };
  const read: { name: string; doc: SavedDoc["doc"] }[] = [];
  for (const [at, entry] of docs.entries()) {
    const { name, doc } = (typeof entry === "object" && entry !== null ? entry : {}) as {
      name?: unknown;
      doc?: unknown;
    };
    const parsed = parseDoc(doc, kinds);
    if ("why" in parsed) return { why: `Document ${at + 1}: ${parsed.why}` };
    const named = typeof name === "string" && name.trim() !== "" ? name : parsed.doc.title;
    read.push({ name: named.trim() || "Untitled", doc: parsed.doc });
  }
  if (setups.length === 0 && read.length === 0) return { why: "It holds nothing saved." };
  return { setups, docs: read };
}

/** `name`, or the first of "name 2", "name 3"… that `taken` does not hold. */
export function freeName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`;
}

/** The setups and documents saved here with what `brought` adds (at `now`), each document under a free name. */
export function mergeSaved(
  setups: readonly Preset[],
  docs: readonly SavedDoc[],
  brought: SavedImport,
  now: number,
): { readonly setups: Preset[]; readonly docs: SavedDoc[] } {
  let merged: SavedDoc[] = [...docs];
  for (const { name, doc } of brought.docs)
    merged = saveDoc(
      merged,
      freeName(
        name,
        merged.map((saved) => saved.name),
      ),
      doc,
      now,
    );
  return { setups: [...setups, ...brought.setups], docs: merged };
}
