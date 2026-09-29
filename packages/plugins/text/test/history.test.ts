import { afterEach, describe, expect, test } from "bun:test";
import { MAX_TEXT_LENGTH } from "@manifold/protocol";
import { Y } from "@manifold/scene";
import { applyTextHistory } from "../src/history.ts";

const documents: Y.Doc[] = [];
afterEach(() => {
  for (const doc of documents) doc.destroy();
  documents.length = 0;
});

function fixture(initial: string) {
  const doc = new Y.Doc();
  documents.push(doc);
  const text = new Y.Text(initial);
  doc.getMap<Y.Text>("bodies").set("document", text);
  const origin = Symbol("editor");
  const history = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  return {
    doc,
    text,
    history,
    edit(fn: (body: Y.Text) => void) {
      history.stopCapturing();
      doc.transact(() => fn(text), origin);
    },
    peer(fn: (body: Y.Text) => void) {
      const peer = new Y.Doc();
      try {
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
        const body = peer.getMap<Y.Text>("bodies").get("document");
        if (body === undefined) throw new Error("Missing peer body");
        fn(body);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
      } finally {
        peer.destroy();
      }
    },
  };
}

describe("bounded collaborative history", () => {
  test("undo refuses peer-induced overflow without consuming live history or selection metadata", () => {
    const f = fixture("x".repeat(MAX_TEXT_LENGTH));
    f.edit((text) => text.delete(0, 1));
    f.peer((text) => text.insert(0, "p"));
    const item = f.history.undoStack[0]!;
    const selection = { anchor: 1, head: 2 };
    item.meta.set("selection", selection);
    const before = Y.encodeStateAsUpdate(f.doc);
    let updates = 0;
    f.doc.on("update", () => updates++);
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("limit");
    expect(f.text.length).toBe(MAX_TEXT_LENGTH);
    expect(Y.encodeStateAsUpdate(f.doc)).toEqual(before);
    expect(updates).toBe(0);
    expect(f.history.undoStack).toEqual([item]);
    expect(f.history.undoStack[0]).toBe(item);
    expect(item.meta.get("selection")).toBe(selection);
    expect(f.history.redoStack).toEqual([]);
    // A refusal is retryable after a peer frees room; their surviving text is not undone.
    f.peer((text) => text.delete(text.length - 1, 1));
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("applied");
    expect(f.text.length).toBe(MAX_TEXT_LENGTH);
    expect(f.text.toString().includes("p")).toBe(true);
    expect(applyTextHistory(f.text, f.history, "redo", false)).toBe("applied");
    expect(f.text.length).toBe(MAX_TEXT_LENGTH - 1);
  });

  test("redo is checked before restoring a local insertion after a peer fills its space", () => {
    const f = fixture("x".repeat(MAX_TEXT_LENGTH - 1));
    f.edit((text) => text.insert(0, "a"));
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("applied");
    f.peer((text) => text.insert(0, "p"));
    const redoItem = f.history.redoStack[0];
    const before = Y.encodeStateAsUpdate(f.doc);
    expect(applyTextHistory(f.text, f.history, "redo", false)).toBe("limit");
    expect(f.history.redoStack[0]).toBe(redoItem);
    expect(Y.encodeStateAsUpdate(f.doc)).toEqual(before);
    f.peer((text) => text.delete(text.length - 1, 1));
    expect(applyTextHistory(f.text, f.history, "redo", false)).toBe("applied");
    expect(f.text.length).toBe(MAX_TEXT_LENGTH);
    expect(f.text.toString().includes("a")).toBe(true);
    expect(f.text.toString().includes("p")).toBe(true);
  });

  test("a no-op top entry cannot conceal an overflowing older undo", () => {
    const f = fixture("x".repeat(MAX_TEXT_LENGTH));
    f.edit((text) => text.delete(0, 1));
    f.edit((text) => text.insert(text.length, "z"));
    f.peer((text) => {
      text.delete(text.length - 1, 1);
      text.insert(0, "p");
    });
    const entries = f.history.undoStack.slice();
    expect(entries).toHaveLength(2);
    const before = Y.encodeStateAsUpdate(f.doc);
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("limit");
    expect(Y.encodeStateAsUpdate(f.doc)).toEqual(before);
    expect(f.history.undoStack[0]).toBe(entries[0]);
    expect(f.history.undoStack[1]).toBe(entries[1]);
  });

  test("a counterfactual follows replica-local redone links when restoring a replacement", () => {
    const f = fixture("x".repeat(MAX_TEXT_LENGTH));
    f.edit((text) => { text.delete(0, 1); text.insert(0, "a"); });
    f.edit((text) => text.delete(0, 1));
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("applied");
    expect(f.text.toString()).toBe("a" + "x".repeat(MAX_TEXT_LENGTH - 1));
    // The original insertion now points to its redone Item, a pointer absent from updates.
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("applied");
    expect(f.text.toString()).toBe("x".repeat(MAX_TEXT_LENGTH));
    expect(applyTextHistory(f.text, f.history, "redo", false)).toBe("applied");
    expect(f.text.toString()).toBe("a" + "x".repeat(MAX_TEXT_LENGTH - 1));
  });

  test("both history directions respect read-only without discarding their entries", () => {
    const f = fixture("before");
    f.edit((text) => text.insert(text.length, " after"));
    const undoItem = f.history.undoStack[0];
    expect(applyTextHistory(f.text, f.history, "undo", true)).toBe("read-only");
    expect(f.text.toString()).toBe("before after");
    expect(f.history.undoStack[0]).toBe(undoItem);
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("applied");
    const redoItem = f.history.redoStack[0];
    expect(applyTextHistory(f.text, f.history, "redo", true)).toBe("read-only");
    expect(f.text.toString()).toBe("before");
    expect(f.history.redoStack[0]).toBe(redoItem);
  });

  test("Unicode history uses UTF-16 bounds and preserves attributed characters", () => {
    const f = fixture("x".repeat(MAX_TEXT_LENGTH - 2) + "😀");
    f.edit((text) => text.delete(text.length - 2, 2));
    f.peer((text) => text.insert(0, "e\u0301", { bold: true }));
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("limit");
    expect(f.text.length).toBe(MAX_TEXT_LENGTH);
    f.peer((text) => text.delete(2, 2));
    expect(applyTextHistory(f.text, f.history, "undo", false)).toBe("applied");
    expect(f.text.length).toBe(MAX_TEXT_LENGTH);
    expect(f.text.toString().endsWith("😀")).toBe(true);
    expect(f.text.toDelta()[0]).toEqual({ insert: "e\u0301", attributes: { bold: true } });
  });
});
