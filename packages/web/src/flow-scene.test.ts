import { describe, expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import {
  applyNodeMove,
  bumpElement,
  NONCE_LIMIT,
  projectTerminals,
  randomNonce,
  terminalBinding,
  TERMINAL_LINK,
} from "./flow-scene.ts";

function element(overrides: Readonly<Record<string, unknown>>): SceneElement {
  return {
    id: "e1",
    version: 1,
    versionNonce: 10,
    isDeleted: false,
    index: "a0",
    link: TERMINAL_LINK,
    customData: { kind: "terminal", sessionId: "s1" },
    x: 10,
    y: 20,
    width: 720,
    height: 480,
    ...overrides,
  } as SceneElement;
}

function sceneOf(...elements: readonly SceneElement[]): Map<string, SceneElement> {
  return new Map(elements.map((entry) => [entry.id, entry]));
}

describe("terminalBinding", () => {
  test("accepts a live terminal embeddable", () => {
    expect(terminalBinding(element({}))?.sessionId).toBe("s1");
  });

  test("rejects tombstones so a closed terminal stops rendering", () => {
    expect(terminalBinding(element({ isDeleted: true }))).toBeNull();
  });

  test("rejects non-terminal links, leaving ink and web embeds unprojected", () => {
    expect(terminalBinding(element({ link: "https://example.com" }))).toBeNull();
    expect(terminalBinding(element({ link: undefined }))).toBeNull();
  });

  test("rejects an unbound terminal surface that has no session yet", () => {
    const unbound = element({ customData: { showHyperlinkIcon: false } });
    expect(terminalBinding(unbound)).toBeNull();
  });
});

describe("projectTerminals", () => {
  test("orders nodes by fractional index and assigns ascending zIndex bands", () => {
    const scene = sceneOf(
      element({ id: "late", index: "a2", customData: { kind: "terminal", sessionId: "s3" } }),
      element({ id: "early", index: "a0", customData: { kind: "terminal", sessionId: "s1" } }),
      element({ id: "mid", index: "a1", customData: { kind: "terminal", sessionId: "s2" } }),
    );
    const nodes = projectTerminals(scene);
    expect(nodes.map((node) => node.id)).toEqual(["early", "mid", "late"]);
    expect(nodes.map((node) => node.zIndex)).toEqual([1, 2, 3]);
  });

  test("carries geometry through as position plus explicit width and height", () => {
    const [node] = projectTerminals(sceneOf(element({ x: -40, y: 15 })));
    expect(node?.position).toEqual({ x: -40, y: 15 });
    expect(node?.width).toBe(720);
    expect(node?.height).toBe(480);
    expect(node?.data.sessionId).toBe("s1");
  });

  test("skips elements with unusable geometry instead of stacking them at the origin", () => {
    const scene = sceneOf(
      element({ id: "ok" }),
      element({ id: "nan", x: Number.NaN }),
      element({ id: "missing", width: undefined }),
      element({ id: "degenerate", height: 0 }),
    );
    expect(projectTerminals(scene).map((node) => node.id)).toEqual(["ok"]);
  });

  test("projects nothing from a scene of pure drawing content", () => {
    const ink = element({ id: "stroke", link: undefined, customData: undefined });
    expect(projectTerminals(sceneOf(ink))).toEqual([]);
  });
});

describe("version discipline", () => {
  test("bumpElement advances the version pair without mutating its input", () => {
    const original = element({ version: 7, versionNonce: 999 });
    const next = bumpElement(original, { x: 1 }, () => 42);
    expect(next.version).toBe(8);
    expect(next.versionNonce).toBe(42);
    expect(original.version).toBe(7);
    expect(original.versionNonce).toBe(999);
    expect((original as unknown as Record<string, unknown>)["x"]).toBe(10);
  });

  test("randomNonce stays a non-negative 31-bit integer at both extremes", () => {
    expect(randomNonce(() => 0)).toBe(0);
    const highest = randomNonce(() => 0.9999999999);
    expect(Number.isInteger(highest)).toBe(true);
    expect(highest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThan(NONCE_LIMIT);
  });
});

describe("applyNodeMove", () => {
  test("mints a bumped element for a real move", () => {
    const scene = sceneOf(element({ version: 3 }));
    const moved = applyNodeMove(scene, { id: "e1", position: { x: 99, y: 120 } }, () => 5);
    expect(moved).not.toBeNull();
    expect((moved as unknown as Record<string, unknown>)["x"]).toBe(99);
    expect((moved as unknown as Record<string, unknown>)["y"]).toBe(120);
    expect(moved?.version).toBe(4);
  });

  test("returns null when the position is unchanged, so echoes never touch the wire", () => {
    const scene = sceneOf(element({ x: 10, y: 20 }));
    expect(applyNodeMove(scene, { id: "e1", position: { x: 10, y: 20 } })).toBeNull();
  });

  test("returns null for an unknown id rather than inventing an element", () => {
    expect(
      applyNodeMove(sceneOf(element({})), { id: "ghost", position: { x: 1, y: 2 } }),
    ).toBeNull();
  });
});

describe("drag-stop round trip", () => {
  /**
   * Regression: the first spike committed from `onNodesChange`, whose drag-end change
   * carries `dragging: false` but no `position`, so nothing was ever published — the node
   * moved on screen and snapped back on reload. This pins the path the fix restored: a
   * finished drag must survive being written into the scene and re-projected.
   */
  test("a committed move survives re-projection at the new position", () => {
    const scene = sceneOf(element({ x: 220, y: 210, version: 4 }));
    const moved = applyNodeMove(scene, { id: "e1", position: { x: 340, y: 306 } }, () => 7);
    expect(moved).not.toBeNull();
    if (moved === null) return;

    scene.set(moved.id, moved);
    const [node] = projectTerminals(scene);
    expect(node?.position).toEqual({ x: 340, y: 306 });
    expect(node?.data.sessionId).toBe("s1");
    expect(moved.version).toBe(5);
  });

  test("re-committing the same finished position is a no-op, so a drag cannot double-publish", () => {
    const scene = sceneOf(element({ x: 220, y: 210 }));
    const first = applyNodeMove(scene, { id: "e1", position: { x: 340, y: 306 } });
    expect(first).not.toBeNull();
    if (first === null) return;
    scene.set(first.id, first);
    expect(applyNodeMove(scene, { id: "e1", position: { x: 340, y: 306 } })).toBeNull();
  });
});
