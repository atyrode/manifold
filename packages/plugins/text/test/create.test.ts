import { describe, expect, test } from "bun:test";
import {
  createSceneDoc,
  elementsMap,
  readElement,
  readSharedText,
  sharedTextsMap,
  sharedTextKey,
  Y,
} from "@manifold/scene";
import { CreateTextInputSchema, TEXT_NAMESPACE } from "../src/index.ts";
import { textHandlers } from "../src/server.ts";

function context(doc: Y.Doc, scope = "home") {
  return {
    rooms: { get: (id: string) => id === "home" ? { doc } : null },
    principal: { id: "authenticated-author" },
    now: () => 42,
    newId: () => "doc",
    outsideScope: (id: string | null) => id === scope ? null : { refused: "outside scope" },
  };
}

describe("document creation", () => {
  test("body and reference are atomic, attributed, and the body outlives its last reference", () => {
    const doc = createSceneDoc();
    const observed: unknown[] = [];
    doc.on("update", () => observed.push({
      body: readSharedText(doc, TEXT_NAMESPACE, "doc")?.text,
      reference: readElement(doc, "doc")?.["document"],
    }));
    const result = textHandlers.create(context(doc), CreateTextInputSchema.parse({
      home: { kind: "container", containerId: "home" },
      text: "Retained 😀\nprose",
    }));
    expect(result).toEqual({ containerId: "home", documentId: "doc", reference: '["home","doc"]' });
    expect(observed).toEqual([{ body: "Retained 😀\nprose", reference: '["home","doc"]' }]);
    expect(readSharedText(doc, TEXT_NAMESPACE, "doc")).toEqual({
      namespace: TEXT_NAMESPACE,
      id: "doc",
      text: "Retained 😀\nprose",
      lastEditedBy: "authenticated-author",
      lastEditedAt: 42,
    });
    elementsMap(doc).delete("doc");
    expect(readElement(doc, "doc")).toBeNull();
    expect(readSharedText(doc, TEXT_NAMESPACE, "doc")?.text).toBe("Retained 😀\nprose");
    doc.destroy();
  });

  test("a child can create only a body and cannot overwrite an occupied identity", () => {
    const doc = createSceneDoc();
    const args = CreateTextInputSchema.parse({
      home: { kind: "container", containerId: "home" },
      reference: false,
      text: "Borrowed body",
    });
    textHandlers.create(context(doc), args);
    expect(readElement(doc, "doc")).toBeNull();
    const before = Y.encodeStateAsUpdate(doc);
    expect(textHandlers.create(context(doc), { ...args, reference: true })).toHaveProperty("refused");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readSharedText(doc, TEXT_NAMESPACE, "doc")?.text).toBe("Borrowed body");
    doc.destroy();
  });

  test("scope and occupied raw keys refuse before either half is written", () => {
    const doc = createSceneDoc();
    const args = CreateTextInputSchema.parse({ home: { kind: "container", containerId: "home" } });
    expect(textHandlers.create(context(doc, "other"), args)).toHaveProperty("refused");
    expect(readSharedText(doc, TEXT_NAMESPACE, "doc")).toBeNull();
    sharedTextsMap(doc).set(sharedTextKey(TEXT_NAMESPACE, "doc"), new Y.Map<unknown>());
    expect(textHandlers.create(context(doc), args)).toHaveProperty("refused");
    expect(readElement(doc, "doc")).toBeNull();
    doc.destroy();
  });
});
