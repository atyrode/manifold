import { describe, expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  Y,
  changedElementIds,
  createSceneDoc,
  decodeUpdate,
  elementText,
  elementsMap,
  encodeUpdate,
  nextZIndex,
  patchElement,
  readElement,
  readElements,
  removeElement,
  writeElement,
} from "@manifold/scene";

function terminal(id: string, zIndex = 0): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex,
  };
}

function text(id: string, value = "hello"): SceneElement {
  return {
    id,
    type: "text",
    text: value,
    x: 4,
    y: 8,
    width: 240,
    height: 48,
    zIndex: 1,
    fontSize: 20,
    color: "#f8f9fa",
  };
}

describe("scene document", () => {
  test("round-trips validated elements and ignores malformed records", () => {
    const doc = createSceneDoc();
    writeElement(doc, terminal("one"), LOCAL_ORIGIN);
    expect(readElement(doc, "one")).toEqual(terminal("one"));
    expect(readElements(doc)).toEqual(new Map([["one", terminal("one")]]));

    const invalid = new Y.Map<unknown>();
    invalid.set("id", "invalid");
    invalid.set("type", "terminal");
    elementsMap(doc).set("invalid", invalid);
    expect(readElement(doc, "invalid")).toBeNull();
  });

  test("stores text as a fresh collaborative type", () => {
    const doc = createSceneDoc();
    writeElement(doc, text("note", "first"), LOCAL_ORIGIN);
    const first = elementText(doc, "note");
    expect(first).toBeInstanceOf(Y.Text);
    expect(first?.toString()).toBe("first");

    writeElement(doc, text("note", "second"), LOCAL_ORIGIN);
    const second = elementText(doc, "note");
    expect(second).not.toBe(first);
    expect(second?.toString()).toBe("second");
    expect(readElement(doc, "note")).toEqual(text("note", "second"));
  });

  test("patches primitive fields and routes text through Y.Text", () => {
    const doc = createSceneDoc();
    writeElement(doc, text("note"), LOCAL_ORIGIN);
    expect(patchElement(doc, "missing", { x: 1 }, LOCAL_ORIGIN)).toBeFalse();
    expect(patchElement(doc, "note", { x: 12, height: 72 }, LOCAL_ORIGIN)).toBeTrue();
    expect(readElement(doc, "note")).toMatchObject({ x: 12, height: 72 });
    expect(() => patchElement(doc, "note", { text: "replacement" } as never, LOCAL_ORIGIN)).toThrow(
      "elementText",
    );
  });

  test("reports changed ids synchronously for root and nested edits", () => {
    const doc = createSceneDoc();
    const batches: string[][] = [];
    elementsMap(doc).observeDeep((events) => {
      batches.push(changedElementIds(events as unknown as readonly Y.YEvent<never>[]));
    });

    writeElement(doc, text("note"), LOCAL_ORIGIN);
    elementText(doc, "note")?.insert(0, "new ");
    expect(batches).toEqual([["note"], ["note"]]);
  });

  test("removes records and computes the next z-index", () => {
    const doc = createSceneDoc();
    expect(nextZIndex(doc)).toBe(0);
    writeElement(doc, terminal("low", -2), LOCAL_ORIGIN);
    writeElement(doc, terminal("high", 7), LOCAL_ORIGIN);
    expect(nextZIndex(doc)).toBe(8);
    expect(removeElement(doc, "high", LOCAL_ORIGIN)).toBeTrue();
    expect(removeElement(doc, "high", LOCAL_ORIGIN)).toBeFalse();
  });

  test("base64-encodes binary document updates", () => {
    const doc = createSceneDoc();
    writeElement(doc, terminal("one"), LOCAL_ORIGIN);
    const update = Y.encodeStateAsUpdate(doc);
    expect(decodeUpdate(encodeUpdate(update))).toEqual(update);

    const replica = createSceneDoc();
    Y.applyUpdate(replica, decodeUpdate(encodeUpdate(update)));
    expect(readElement(replica, "one")).toEqual(terminal("one"));
  });
});
