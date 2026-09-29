import {
  MAX_TEXT_LENGTH,
  SharedTextRecordSchema,
  SharedTextRefSchema,
  type SharedTextRecord,
  type SharedTextRef,
} from "@manifold/protocol";
import * as Y from "yjs";
import { LOCAL_ORIGIN } from "./scene-doc.ts";

const TEXTS_KEY = "texts";

/** Independent records share the room's canonical document and authority home. */
export function sharedTextsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(TEXTS_KEY);
}

export function sharedTextKey(namespace: string, id: string): string {
  SharedTextRefSchema.parse({ namespace, id });
  return `${namespace}:${id}`;
}

export function parseSharedTextKey(key: string): SharedTextRef | null {
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  const ref = SharedTextRefSchema.safeParse({
    namespace: key.slice(0, separator),
    id: key.slice(separator + 1),
  });
  return ref.success ? ref.data : null;
}

function validatedText(
  doc: Y.Doc,
  namespace: string,
  id: string,
): { record: SharedTextRecord; text: Y.Text } | null {
  if (!SharedTextRefSchema.safeParse({ namespace, id }).success) return null;
  const map = sharedTextsMap(doc).get(`${namespace}:${id}`);
  if (!(map instanceof Y.Map) || map.size < 3 || map.size > 5) return null;
  const text: unknown = map.get("text");
  if (!(text instanceof Y.Text) || text.constructor !== Y.Text || text.length > MAX_TEXT_LENGTH) {
    return null;
  }
  // toString() silently drops embeds. Validate the live body before projecting it, while
  // leaving all text formatting attributes in place for other editors and future reads.
  if (text.toDelta().some((part) => typeof part.insert !== "string")) return null;
  const fields: Record<string, unknown> = Object.fromEntries(map.entries());
  fields["text"] = text.toString();
  const parsed = SharedTextRecordSchema.safeParse(fields);
  if (!parsed.success || parsed.data.namespace !== namespace || parsed.data.id !== id) return null;
  return { record: parsed.data, text };
}

/** Refuses occupied keys, including malformed raw records; creation is never replacement. */
export function createSharedText(
  doc: Y.Doc,
  record: SharedTextRecord,
  origin: unknown = LOCAL_ORIGIN,
): Y.Text {
  const parsed = SharedTextRecordSchema.parse(record);
  const key = sharedTextKey(parsed.namespace, parsed.id);
  const texts = sharedTextsMap(doc);
  if (texts.has(key)) throw new Error(`Shared text already exists: ${key}`);
  const text = new Y.Text(parsed.text);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("namespace", parsed.namespace);
    map.set("id", parsed.id);
    map.set("text", text);
    if (parsed.lastEditedBy !== undefined) map.set("lastEditedBy", parsed.lastEditedBy);
    if (parsed.lastEditedAt !== undefined) map.set("lastEditedAt", parsed.lastEditedAt);
    texts.set(key, map);
  }, origin);
  return text;
}

export function sharedText(doc: Y.Doc, namespace: string, id: string): Y.Text | null {
  return validatedText(doc, namespace, id)?.text ?? null;
}

export function readSharedText(doc: Y.Doc, namespace: string, id: string): SharedTextRecord | null {
  return validatedText(doc, namespace, id)?.record ?? null;
}

export function listSharedTexts(doc: Y.Doc, namespace?: string): readonly SharedTextRecord[] {
  const records: SharedTextRecord[] = [];
  for (const key of sharedTextsMap(doc).keys()) {
    const ref = parseSharedTextKey(key);
    if (ref === null || (namespace !== undefined && ref.namespace !== namespace)) continue;
    const record = readSharedText(doc, ref.namespace, ref.id);
    if (record !== null) records.push(record);
  }
  return records;
}

export function removeSharedText(
  doc: Y.Doc,
  namespace: string,
  id: string,
  origin: unknown = LOCAL_ORIGIN,
): boolean {
  const key = sharedTextKey(namespace, id);
  const texts = sharedTextsMap(doc);
  if (!texts.has(key)) return false;
  doc.transact(() => texts.delete(key), origin);
  return true;
}

export function stampSharedTextAuthorship(
  doc: Y.Doc,
  refs: readonly SharedTextRef[],
  by: string,
  at: number,
  origin: unknown,
): void {
  // Validate server-supplied metadata too; this helper must not author invalid records.
  SharedTextRecordSchema.shape.lastEditedBy.unwrap().parse(by);
  SharedTextRecordSchema.shape.lastEditedAt.unwrap().parse(at);
  doc.transact(() => {
    for (const ref of refs) {
      if (readSharedText(doc, ref.namespace, ref.id) === null) continue;
      const map = sharedTextsMap(doc).get(sharedTextKey(ref.namespace, ref.id));
      if (!(map instanceof Y.Map)) continue;
      map.set("lastEditedBy", by);
      map.set("lastEditedAt", at);
    }
  }, origin);
}

/** Retention is deliberately not a visual census or an owner-enablement decision. */
export function hasRetainedContent(doc: Y.Doc): boolean {
  return sharedTextsMap(doc).size > 0;
}

/** Includes malformed raw keys so the receiving boundary can repair them, too. */
export function changedSharedTextKeys(events: readonly Y.YEvent<never>[]): string[] {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.path.length === 0) {
      for (const key of event.changes.keys.keys()) keys.add(key);
    } else {
      keys.add(String(event.path[0]));
    }
  }
  return [...keys];
}
