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

export function writeElement(doc: Y.Doc, element: SceneElement, origin: unknown): void {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(element)) {
      if (key !== "text") map.set(key, value);
    }
    if (element.type === "text") map.set("text", new Y.Text(element.text));
    elementsMap(doc).set(element.id, map);
  }, origin);
}

export function patchElement(doc: Y.Doc, id: string, patch: ScenePatch, origin: unknown): boolean {
  const map = elementsMap(doc).get(id);
  if (!(map instanceof Y.Map)) return false;
  if (Object.hasOwn(patch, "text")) {
    throw new Error("Text elements must be edited through elementText()");
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

export function elementText(doc: Y.Doc, id: string): Y.Text | null {
  const map = elementsMap(doc).get(id);
  if (!(map instanceof Y.Map) || map.get("type") !== "text") return null;
  const text = map.get("text");
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
