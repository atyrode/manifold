import { SceneElementSchema, type SceneElement } from "@manifold/protocol";
import * as Y from "yjs";

export const LOCAL_ORIGIN: unique symbol = Symbol("manifold.local");
export const REMOTE_ORIGIN: unique symbol = Symbol("manifold.remote");
export const REPAIR_ORIGIN: unique symbol = Symbol("manifold.repair");
export const SERVER_PLACE_ORIGIN: unique symbol = Symbol("manifold.serverPlace");
export const ELEMENTS_KEY = "elements";

export const DEFAULT_TERMINAL_WIDTH = 720;
export const DEFAULT_TERMINAL_HEIGHT = 480;

type PatchOf<T> = T extends SceneElement ? Partial<Omit<T, "id" | "type">> : never;
export type ScenePatch = PatchOf<SceneElement>;

export function createSceneDoc(): Y.Doc {
  return new Y.Doc();
}

export function elementsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
}

export function readElement(doc: Y.Doc, id: string): SceneElement | null {
  const map = elementsMap(doc).get(id);
  if (!(map instanceof Y.Map)) return null;
  const parsed = SceneElementSchema.safeParse(map.toJSON());
  return parsed.success ? parsed.data : null;
}

export function readElements(doc: Y.Doc): Map<string, SceneElement> {
  const elements = new Map<string, SceneElement>();
  for (const id of elementsMap(doc).keys()) {
    const element = readElement(doc, id);
    if (element !== null) elements.set(id, element);
  }
  return elements;
}

/**
 * Writes one element, declaring which of its PAYLOAD fields are collaborative text.
 *
 * This used to read `if (element.type === "text") map.set("text", new Y.Text(element.text))` —
 * the floor asserting both a plugin's type name and a plugin's field name, and the last domain
 * noun in the scene pillar (ADR 0013 §16 clause 6). It splits by who actually knows. A CREATOR
 * names its own collaborative fields, and the creator is the owning plugin. A RE-WRITE of an
 * existing element derives them from the document with {@link collaborativeTextFields}, so the
 * floor's own re-write sites — repoint, move, adopt across documents — preserve collaborative
 * text without naming a field, and preserve a stranger plugin's collaborative field exactly as
 * well as `core.notes`'.
 *
 * The default is EMPTY rather than clever. A field silently promoted to `Y.Text` would be a
 * plain string one client and a shared type the next; a field silently demoted loses an editor
 * a person is typing into. Both failures are quiet, so the declaration is explicit and the
 * re-write sites carry a call to the reader above them.
 */
export function writeElement(
  doc: Y.Doc,
  element: SceneElement,
  origin: unknown,
  collaborative: readonly string[] = [],
): void {
  const isCollaborative: Readonly<Record<string, true>> = Object.fromEntries(
    collaborative.map((field) => [field, true]),
  );
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(element)) {
      if (isCollaborative[key] === true) continue;
      map.set(key, value);
    }
    for (const field of collaborative) {
      const value: unknown = element[field];
      map.set(field, new Y.Text(typeof value === "string" ? value : ""));
    }
    elementsMap(doc).set(element.id, map);
  }, origin);
}

/**
 * Which of an element's fields are stored as collaborative text RIGHT NOW, read from the
 * document rather than from a table. Structural on purpose: it is what lets a floor re-write
 * carry a shared type it cannot interpret, and it answers empty for an element that is absent
 * or holds none.
 */
export function collaborativeTextFields(doc: Y.Doc, id: string): readonly string[] {
  const map = elementsMap(doc).get(id);
  if (!(map instanceof Y.Map)) return [];
  const fields: string[] = [];
  for (const [key, value] of map.entries()) {
    if (value instanceof Y.Text) fields.push(key);
  }
  return fields;
}

export function patchElement(doc: Y.Doc, id: string, patch: ScenePatch, origin: unknown): boolean {
  const map = elementsMap(doc).get(id);
  if (!(map instanceof Y.Map)) return false;
  /*
    Refusing by SHAPE rather than by name: any field currently stored as a shared type is one a
    patch would clobber, whatever its owner calls it. The old test was `hasOwn(patch, "text")`,
    which protected exactly one plugin's field and silently let a stranger plugin's collaborative
    field be overwritten by a `set` — the same defect in the same place, one plugin later.
  */
  for (const field of collaborativeTextFields(doc, id)) {
    if (Object.hasOwn(patch, field)) {
      throw new Error(`Collaborative field "${field}" must be edited through elementText()`);
    }
  }

  for (const value of Object.values(patch)) {
    if (value !== undefined && (typeof value === "object" || typeof value === "function")) {
      throw new Error("Scene patches may contain primitive fields only");
    }
  }

  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) map.set(key, value);
    }
  }, origin);
  return true;
}

export function removeElement(doc: Y.Doc, id: string, origin: unknown): boolean {
  const elements = elementsMap(doc);
  if (!elements.has(id)) return false;
  doc.transact(() => {
    elements.delete(id);
  }, origin);
  return true;
}

/**
 * An element's collaborative text, when it has exactly one such field.
 *
 * The published contract (`ElementDocument.elementText(elementId)`, docs/PLUGINS.md) has always
 * presumed one, and this says so structurally instead of by naming the `text` field of the
 * `text` type. Two such fields is a shape nothing in the tree has, and answering "the" text for
 * an element that holds two would be a guess — so it answers null and the owner reaches for its
 * own field through the document.
 */
export function elementText(doc: Y.Doc, id: string): Y.Text | null {
  const map = elementsMap(doc).get(id);
  if (!(map instanceof Y.Map)) return null;
  const [field, ...rest] = collaborativeTextFields(doc, id);
  if (field === undefined || rest.length > 0) return null;
  const text = map.get(field);
  return text instanceof Y.Text ? text : null;
}

export function changedElementIds(events: readonly Y.YEvent<never>[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.path.length === 0) {
      for (const id of event.changes.keys.keys()) ids.add(id);
    } else {
      ids.add(String(event.path[0]));
    }
  }
  return [...ids];
}

export function nextZIndex(doc: Y.Doc): number {
  let max = -1;
  for (const element of readElements(doc).values()) {
    max = Math.max(max, element.zIndex);
  }
  return max + 1;
}

export function encodeUpdate(update: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < update.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...update.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

export function decodeUpdate(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const update = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    update[index] = binary.charCodeAt(index);
  }
  return update;
}
