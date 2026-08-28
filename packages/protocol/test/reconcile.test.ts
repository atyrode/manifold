import { describe, expect, test } from "bun:test";
import {
  applyAccepted,
  compareElements,
  reconcile,
  shouldAccept,
  type SceneElement,
} from "@manifold/protocol";

function el(
  id: string,
  version: number,
  versionNonce: number,
  extra?: Partial<SceneElement>,
): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    version,
    versionNonce,
    isDeleted: false,
    ...extra,
  };
}

describe("shouldAccept — LWW acceptance matrix", () => {
  test("unknown element is accepted", () => {
    expect(shouldAccept(undefined, el("a", 0, 0))).toBe(true);
  });

  test("higher version wins regardless of nonce", () => {
    expect(shouldAccept(el("a", 1, 0), el("a", 2, 999))).toBe(true);
    expect(shouldAccept(el("a", 2, 999), el("a", 1, 0))).toBe(false);
  });

  test("equal version: lower versionNonce wins deterministically", () => {
    expect(shouldAccept(el("a", 3, 500), el("a", 3, 100))).toBe(true);
    expect(shouldAccept(el("a", 3, 100), el("a", 3, 500))).toBe(false);
  });

  test("identical version+nonce is an idempotent duplicate", () => {
    expect(shouldAccept(el("a", 3, 100), el("a", 3, 100))).toBe(false);
  });

  test("commutativity of concurrent edits: exactly one side wins either order", () => {
    const left = el("a", 4, 10);
    const right = el("a", 4, 20);
    expect(shouldAccept(left, right)).toBe(false);
    expect(shouldAccept(right, left)).toBe(true);
  });
});

describe("deletion semantics", () => {
  test("delete is an ordinary versioned update", () => {
    const live = el("a", 2, 5);
    const deleted = el("a", 3, 7, { isDeleted: true });
    expect(shouldAccept(live, deleted)).toBe(true);
  });

  test("stale pre-delete copy loses against a retained tombstone", () => {
    const tombstone = el("a", 5, 1, { isDeleted: true });
    const staleLive = el("a", 4, 0);
    expect(shouldAccept(tombstone, staleLive)).toBe(false);
  });

  test("undo-of-delete resurrects legitimately via higher version", () => {
    const tombstone = el("a", 5, 1, { isDeleted: true });
    const undone = el("a", 6, 2);
    expect(shouldAccept(tombstone, undone)).toBe(true);
  });
});

describe("reconcile — batch semantics", () => {
  test("accepts winners, rejects losers, preserves input order", () => {
    const current = new Map([
      ["a", el("a", 2, 0)],
      ["b", el("b", 5, 0)],
    ]);
    const { accepted } = reconcile(current, [el("b", 4, 0), el("a", 3, 0), el("c", 0, 0)]);
    expect(accepted.map((e) => e.id)).toEqual(["a", "c"]);
  });

  test("duplicate ids within a batch reconcile against staged winners", () => {
    const { accepted } = reconcile(new Map(), [el("a", 1, 0), el("a", 2, 0), el("a", 1, 9)]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.version).toBe(2);
  });

  test("re-applying the same batch is a no-op (idempotence)", () => {
    const state = new Map<string, SceneElement>();
    const batch = [el("a", 1, 0), el("b", 2, 0)];
    applyAccepted(state, reconcile(state, batch).accepted);
    const second = reconcile(state, batch);
    expect(second.accepted).toHaveLength(0);
  });

  test("never mutates inputs", () => {
    const current = new Map([["a", el("a", 1, 0)]]);
    const incoming = [el("a", 2, 0)];
    reconcile(current, incoming);
    expect(current.get("a")?.version).toBe(1);
    expect(incoming).toHaveLength(1);
  });
});

describe("compareElements — canonical order", () => {
  test("z-index first, id as deterministic tiebreak", () => {
    const els = [
      el("z", 0, 0, { zIndex: 2 }),
      el("a", 0, 0, { zIndex: 1 }),
      el("m", 0, 0, { zIndex: 0 }),
      el("b", 0, 0, { zIndex: 1 }),
    ];
    const sorted = [...els].sort(compareElements);
    expect(sorted.map((element) => element.id)).toEqual(["m", "a", "b", "z"]);
  });
});
