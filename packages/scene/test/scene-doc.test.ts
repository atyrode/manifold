import { describe, expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  Y,
  changedElementIds,
  collaborativeTextFields,
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

function portal(id: string, zIndex = 0): SceneElement {
  return {
    id,
    type: "portal",
    containerId: `container-${id}`,
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

/**
 * Which of this fixture's fields the document holds as shared text. The author declares it now
 * (ADR 0013 §16 clause 6) — the floor used to infer it from the `text` TYPE NAME, which meant
 * the scene pillar knew one plugin's kind and one plugin's field. Passing it here is what a
 * real author does, so the fixture exercises the real path.
 */
const NOTE_COLLABORATIVE: readonly string[] = ["text"];

describe("scene document", () => {
  test("round-trips validated elements and ignores malformed records", () => {
    const doc = createSceneDoc();
    writeElement(doc, portal("one"), LOCAL_ORIGIN);
    expect(readElement(doc, "one")).toEqual(portal("one"));
    expect(readElements(doc)).toEqual(new Map([["one", portal("one")]]));

    const invalid = new Y.Map<unknown>();
    invalid.set("id", "invalid");
    invalid.set("type", "portal");
    elementsMap(doc).set("invalid", invalid);
    expect(readElement(doc, "invalid")).toBeNull();
  });

  test("stores a declared field as a fresh collaborative type", () => {
    const doc = createSceneDoc();
    writeElement(doc, text("note", "first"), LOCAL_ORIGIN, NOTE_COLLABORATIVE);
    const first = elementText(doc, "note");
    expect(first).toBeInstanceOf(Y.Text);
    expect(first?.toString()).toBe("first");
    expect(collaborativeTextFields(doc, "note")).toEqual(["text"]);

    writeElement(doc, text("note", "second"), LOCAL_ORIGIN, NOTE_COLLABORATIVE);
    const second = elementText(doc, "note");
    expect(second).not.toBe(first);
    expect(second?.toString()).toBe("second");
    expect(readElement(doc, "note")).toEqual(text("note", "second"));
  });

  test("an undeclared field stays a plain value, and a stranger field can be the shared one", () => {
    const doc = createSceneDoc();
    // Declared nothing: the payload is carried verbatim and nothing is a shared type, which is
    // what makes the declaration load-bearing rather than decorative.
    writeElement(doc, text("plain"), LOCAL_ORIGIN);
    expect(collaborativeTextFields(doc, "plain")).toEqual([]);
    expect(elementText(doc, "plain")).toBeNull();
    expect(readElement(doc, "plain")).toEqual(text("plain"));

    // A STRANGER plugin's collaborative field works identically: the rule is structural, so
    // nothing about it is `core.notes`-shaped.
    const stranger: SceneElement = {
      id: "stranger",
      type: "acme.diagram",
      caption: "hello",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      zIndex: 0,
    };
    writeElement(doc, stranger, LOCAL_ORIGIN, ["caption"]);
    expect(collaborativeTextFields(doc, "stranger")).toEqual(["caption"]);
    expect(elementText(doc, "stranger")?.toString()).toBe("hello");
  });

  test("patches primitive fields and refuses to clobber a shared field by shape", () => {
    const doc = createSceneDoc();
    writeElement(doc, text("note"), LOCAL_ORIGIN, NOTE_COLLABORATIVE);
    expect(patchElement(doc, "missing", { x: 1 }, LOCAL_ORIGIN)).toBeFalse();
    expect(patchElement(doc, "note", { x: 12, height: 72 }, LOCAL_ORIGIN)).toBeTrue();
    expect(readElement(doc, "note")).toMatchObject({ x: 12, height: 72 });
    expect(() => patchElement(doc, "note", { text: "replacement" }, LOCAL_ORIGIN)).toThrow(
      "elementText",
    );
    // The refusal follows the SHAPE, not the name: a field that is not a shared type patches.
    writeElement(doc, text("flat"), LOCAL_ORIGIN);
    expect(patchElement(doc, "flat", { text: "replacement" }, LOCAL_ORIGIN)).toBeTrue();
  });

  test("reports changed ids synchronously for root and nested edits", () => {
    const doc = createSceneDoc();
    const batches: string[][] = [];
    elementsMap(doc).observeDeep((events) => {
      batches.push(changedElementIds(events as unknown as readonly Y.YEvent<never>[]));
    });

    writeElement(doc, text("note"), LOCAL_ORIGIN, NOTE_COLLABORATIVE);
    elementText(doc, "note")?.insert(0, "new ");
    expect(batches).toEqual([["note"], ["note"]]);
  });

  test("removes records and computes the next z-index", () => {
    const doc = createSceneDoc();
    expect(nextZIndex(doc)).toBe(0);
    writeElement(doc, portal("low", -2), LOCAL_ORIGIN);
    writeElement(doc, portal("high", 7), LOCAL_ORIGIN);
    expect(nextZIndex(doc)).toBe(8);
    expect(removeElement(doc, "high", LOCAL_ORIGIN)).toBeTrue();
    expect(removeElement(doc, "high", LOCAL_ORIGIN)).toBeFalse();
  });

  test("base64-encodes binary document updates", () => {
    const doc = createSceneDoc();
    writeElement(doc, portal("one"), LOCAL_ORIGIN);
    const update = Y.encodeStateAsUpdate(doc);
    expect(decodeUpdate(encodeUpdate(update))).toEqual(update);

    const replica = createSceneDoc();
    Y.applyUpdate(replica, decodeUpdate(encodeUpdate(update)));
    expect(readElement(replica, "one")).toEqual(portal("one"));
  });
});
