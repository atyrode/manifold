import { SceneElementSchema, type PluginManifest, type SceneElement } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assembleRoster, elementPayloadRefusal, type PluginDef } from "../src/index.ts";

/**
 * THE element-payload boundary (ADR 0013 §16 clause 5).
 *
 * The two claims under test are the two halves of what opening `SceneElementSchema` bought, and
 * they pull in opposite directions on purpose: a record whose type nobody claims must SURVIVE,
 * and a record whose type IS claimed must be held to its owner's schema. A boundary that only
 * did the first is a hole; one that only did the second is the closed union it replaced.
 */

const NONE = new Set<string>();

function manifest(fields: {
  id: string;
  elements: PluginManifest["contributes"]["elements"];
}): PluginManifest {
  return {
    id: fields.id,
    version: "1.0.0",
    title: fields.id,
    description: "",
    capabilities: [],
    contributes: {
      panels: [],
      sections: [],
      elements: fields.elements,
      tools: [],
      events: [],
    },
  };
}

/**
 * One plugin that DECLARES a payload schema and one that declares only a type. The second is not
 * padding: "declared no schema" is a real declaration — this kind's records carry nothing the
 * engine should police — and it has to be distinguishable from "refused".
 */
const notes: PluginDef = {
  manifest: manifest({ id: "core.notes", elements: [{ type: "text", title: "Note" }] }),
  actions: [],
  elements: {
    text: z.strictObject({
      text: z.string().max(64),
      fontSize: z.number().finite().positive(),
    }),
  },
};

const loose: PluginDef = {
  manifest: manifest({ id: "acme.loose", elements: [{ type: "acme.blob", title: "Blob" }] }),
  actions: [],
};

const assembly = assembleRoster([notes, loose], NONE);

/** A record as the wire carries it: envelope geometry plus whatever payload the case is about. */
function element(type: string, payload: Readonly<Record<string, unknown>>): SceneElement {
  return SceneElementSchema.parse({
    id: `el-${type}`,
    type,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    zIndex: 0,
    ...payload,
  });
}

describe("elementPayloadRefusal", () => {
  test("a well-formed payload for a claimed type passes", () => {
    expect(
      elementPayloadRefusal(assembly.elements, element("text", { text: "hello", fontSize: 20 })),
    ).toBeNull();
  });

  test("a malformed payload for a KNOWN type refuses, naming the owner and the field", () => {
    const refusal = elementPayloadRefusal(
      assembly.elements,
      element("text", { text: "hello", fontSize: -3 }),
    );
    expect(refusal).not.toBeNull();
    expect(refusal?.type).toBe("text");
    // The owner is named because the refusal's whole value is telling a reader who to ask. A
    // discriminated union could only ever have said "matched no member".
    expect(refusal?.plugin).toBe("core.notes");
    expect(refusal?.problems.join(" ")).toContain("fontSize");
  });

  test("a MISSING required field is a refusal, not a tolerated absence", () => {
    // The envelope would carry this record happily: the geometry parses and the payload is in
    // bounds. Only the owner's schema knows a note without a size is not a note.
    const refusal = elementPayloadRefusal(assembly.elements, element("text", { text: "hi" }));
    expect(refusal?.problems.join(" ")).toContain("fontSize");
  });

  test("an EXTRA field for a claimed type refuses, because the owner's schema is strict", () => {
    const refusal = elementPayloadRefusal(
      assembly.elements,
      element("text", { text: "hi", fontSize: 20, rogue: 1 }),
    );
    expect(refusal?.plugin).toBe("core.notes");
  });

  test("a STRANGER type round-trips: nothing claims it, so there is no schema to fail", () => {
    /*
      The property the envelope exists for. Before it, a `type` the protocol's union did not list
      was refused on the wire, so a canvas could not hold a record whose owning plugin was merely
      absent from this build — the outcome ADR 0013 §4 forbids for panels and sections, reached
      through the document plane instead of the layout plane.
    */
    const stranger = element("vendor.gantt", { lanes: ["a", "b"], collapsed: false });
    expect(elementPayloadRefusal(assembly.elements, stranger)).toBeNull();
    expect(assembly.elements.has("vendor.gantt")).toBe(false);
  });

  test("a claimed type whose owner declared NO schema is accepted, not refused", () => {
    // Absence is a declaration: this kind's records carry nothing the engine should police.
    expect(assembly.elements.get("acme.blob")?.payload).toBeNull();
    expect(
      elementPayloadRefusal(assembly.elements, element("acme.blob", { anything: "at all" })),
    ).toBeNull();
  });

  test("the FLOOR's own kind is validated by the floor, and names the engine as its owner", () => {
    /*
      `portal` is the one element kind no plugin contributes — it is A4 addressing — so its schema
      lives in the protocol and is consulted before the assembly. This is what makes the boundary
      total: every record is either the floor's, a plugin's, or a stranger's, and all three answers
      are decided in one place.
    */
    expect(
      elementPayloadRefusal(assembly.elements, element("portal", { containerId: "c-1" })),
    ).toBeNull();
    const refusal = elementPayloadRefusal(
      assembly.elements,
      element("portal", { containerId: "" }),
    );
    expect(refusal?.plugin).toBe("engine");
    expect(refusal?.problems.join(" ")).toContain("containerId");
  });
});
