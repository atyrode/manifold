import { describe, expect, test } from "bun:test";
import { MAX_TEXT_LENGTH } from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  SERVER_AUTHORSHIP_ORIGIN,
  Y,
  createSceneDoc,
  createSharedText,
  hasRetainedContent,
  listSharedTexts,
  parseSharedTextKey,
  readSharedText,
  removeSharedText,
  sharedText,
  sharedTextKey,
  sharedTextsMap,
  stampSharedTextAuthorship,
} from "@manifold/scene";

const namespace = "example.documents";

function rawRecord(id: string, text: unknown = new Y.Text("body")): Y.Map<unknown> {
  return new Y.Map<unknown>([
    ["namespace", namespace],
    ["id", id],
    ["text", text],
  ]);
}

describe("independent shared text records", () => {
  test("opaque ids and unknown owners retain their own records without visual elements", () => {
    const doc = createSceneDoc();
    try {
      const record = {
        namespace,
        id: "opaque:with/slashes:雪",
        text: "Hello 👩🏽‍💻\n世界",
        lastEditedBy: "author",
        lastEditedAt: 123,
      };
      const text = createSharedText(doc, record);
      createSharedText(doc, { namespace: "absent.owner", id: record.id, text: "" });
      expect(parseSharedTextKey(sharedTextKey(namespace, record.id))).toEqual({
        namespace,
        id: record.id,
      });
      expect(sharedText(doc, namespace, record.id)).toBe(text);
      expect(readSharedText(doc, namespace, record.id)).toEqual(record);
      expect(listSharedTexts(doc, namespace)).toEqual([record]);
      expect(hasRetainedContent(doc)).toBe(true);
      expect(removeSharedText(doc, namespace, record.id)).toBe(true);
      expect(readSharedText(doc, namespace, record.id)).toBeNull();
      expect(hasRetainedContent(doc)).toBe(true);
      expect(removeSharedText(doc, "absent.owner", record.id)).toBe(true);
      expect(removeSharedText(doc, "absent.owner", record.id)).toBe(false);
      expect(hasRetainedContent(doc)).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  test("concurrent edits merge Unicode and formatting without replacing the live text", () => {
    const first = createSceneDoc();
    const second = createSceneDoc();
    try {
      const original = createSharedText(first, { namespace, id: "shared", text: "A🌍Z" });
      original.format(1, 2, { emphasis: true });
      Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
      const peer = sharedText(second, namespace, "shared");
      if (peer === null) throw new Error("missing peer text");
      first.transact(() => original.insert(0, "left "), LOCAL_ORIGIN);
      second.transact(() => peer.insert(peer.length, " right"), LOCAL_ORIGIN);
      const left = Y.encodeStateAsUpdate(first);
      const right = Y.encodeStateAsUpdate(second);
      Y.applyUpdate(first, right);
      Y.applyUpdate(second, left);
      expect(sharedText(first, namespace, "shared")).toBe(original);
      expect(original.toString()).toBe("left A🌍Z right");
      expect(peer.toDelta()).toEqual(original.toDelta());
      expect(original.toDelta()).toContainEqual({ insert: "🌍", attributes: { emphasis: true } });
      expect(listSharedTexts(first)).toEqual(listSharedTexts(second));
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  test("collisions refuse replacement even when the existing entry is malformed", () => {
    const doc = createSceneDoc();
    try {
      const original = createSharedText(doc, { namespace, id: "taken", text: "original" });
      expect(() => createSharedText(doc, { namespace, id: "taken", text: "lost" })).toThrow();
      expect(sharedText(doc, namespace, "taken")).toBe(original);
      doc.getMap<unknown>("texts").set(sharedTextKey(namespace, "raw"), "invalid");
      expect(() => createSharedText(doc, { namespace, id: "raw", text: "lost" })).toThrow();
      expect(doc.getMap<unknown>("texts").get(sharedTextKey(namespace, "raw"))).toBe("invalid");
    } finally {
      doc.destroy();
    }
  });

  test("raw records must match their keys, exact schema and live text body", () => {
    const doc = createSceneDoc();
    try {
      const invalid: [string, unknown][] = [
        ["not-a-ref", rawRecord("not-a-ref")],
        ["bad namespace:id", rawRecord("id")],
        [`${namespace}:`, rawRecord("")],
        [sharedTextKey(namespace, "primitive"), "body"],
        [sharedTextKey(namespace, "flat"), rawRecord("flat", "body")],
        [sharedTextKey(namespace, "wrong-id"), rawRecord("another-id")],
        [sharedTextKey(namespace, "array"), rawRecord("array", new Y.Array())],
        [sharedTextKey(namespace, "xml"), rawRecord("xml", new Y.XmlText("not a plaintext body"))],
      ];
      for (const [id, field, value] of [
        ["extra", "extra", true],
        ["namespace", "namespace", "another.owner"],
        ["author", "lastEditedBy", ""],
        ["time", "lastEditedAt", -1],
      ] as const) {
        const map = rawRecord(id);
        map.set(field, value);
        invalid.push([sharedTextKey(namespace, id), map]);
      }
      for (const [key, value] of invalid) doc.getMap<unknown>("texts").set(key, value);
      const embedded = createSharedText(doc, { namespace, id: "embed", text: "before" });
      embedded.insertEmbed(3, { image: "not text" });
      expect(embedded.toString()).toBe("before");
      expect(sharedText(doc, namespace, "embed")).toBeNull();
      expect(readSharedText(doc, namespace, "embed")).toBeNull();
      expect(listSharedTexts(doc)).toEqual([]);
      // Invalid raw data does not authorize an implicit home deletion before server repair.
      expect(hasRetainedContent(doc)).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  test("text bounds are UTF16 bounds and invalid updates are never silently truncated", () => {
    const doc = createSceneDoc();
    try {
      const maximum = "🌍".repeat(MAX_TEXT_LENGTH / 2);
      const text = createSharedText(doc, { namespace, id: "bounded", text: maximum });
      expect(readSharedText(doc, namespace, "bounded")?.text).toBe(maximum);
      text.insert(text.length, "!");
      expect(sharedText(doc, namespace, "bounded")).toBeNull();
      expect(listSharedTexts(doc)).toEqual([]);
      expect(text.toString()).toBe(`${maximum}!`);
      expect(() => createSharedText(doc, { namespace, id: "new", text: `${maximum}!` })).toThrow();
      expect(sharedTextsMap(doc).has(sharedTextKey(namespace, "new"))).toBe(false);
      expect(parseSharedTextKey(`${"a".repeat(129)}:id`)).toBeNull();
      expect(parseSharedTextKey(`${namespace}:${"a".repeat(129)}`)).toBeNull();
    } finally {
      doc.destroy();
    }
  });

  test("authorship updates preserve text identity and do not rehabilitate invalid records", () => {
    const doc = createSceneDoc();
    try {
      const text = createSharedText(doc, { namespace, id: "valid", text: "original" });
      const invalid = rawRecord("invalid", "not a Y.Text");
      sharedTextsMap(doc).set(sharedTextKey(namespace, "invalid"), invalid);
      stampSharedTextAuthorship(
        doc,
        [{ namespace, id: "valid" }, { namespace, id: "invalid" }, { namespace, id: "missing" }],
        "server-actor",
        42,
        SERVER_AUTHORSHIP_ORIGIN,
      );
      expect(sharedText(doc, namespace, "valid")).toBe(text);
      expect(readSharedText(doc, namespace, "valid")).toEqual({
        namespace,
        id: "valid",
        text: "original",
        lastEditedBy: "server-actor",
        lastEditedAt: 42,
      });
      expect(invalid.has("lastEditedBy")).toBe(false);
      expect(readSharedText(doc, namespace, "missing")).toBeNull();
      expect(() => stampSharedTextAuthorship(doc, [{ namespace, id: "valid" }], "", 3, "server")).toThrow();
      expect(readSharedText(doc, namespace, "valid")?.lastEditedBy).toBe("server-actor");
    } finally {
      doc.destroy();
    }
  });
});
