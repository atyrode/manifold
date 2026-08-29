import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_SECTION_ORDER,
  initialCollapsedSections,
  initialSectionOrder,
  moveSection,
} from "./sidebar-section.tsx";

/**
 * The section stack remembers itself in `localStorage`, so the migration path is only observable
 * through that storage: a stub is the whole test seam.
 */
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string): string | null => stored.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        stored.set(key, value);
      },
    },
  },
});

afterEach(() => {
  stored.clear();
});

test("a stack stored before Pads and Views merged folds onto the surviving id", () => {
  stored.set(
    "manifold:sidebar-section-order",
    JSON.stringify(["terminals", "pads", "views", "machines"]),
  );

  expect(initialSectionOrder()).toEqual(["terminals", "views", "machines"]);
});

test("a retired id keeps the slot it was arranged into, and missing ids backfill", () => {
  stored.set("manifold:sidebar-section-order", JSON.stringify(["machines", "pads"]));

  // `pads` becomes `views` in place — the arrangement survives the merge instead of resetting —
  // and `terminals`, never stored on this device, lands beside the neighbour it follows by default.
  expect(initialSectionOrder()).toEqual(["machines", "views", "terminals"]);
});

test("unusable stored order falls back to the default stack", () => {
  stored.set("manifold:sidebar-section-order", "{ not json");
  expect(initialSectionOrder()).toEqual(DEFAULT_SECTION_ORDER);

  stored.set("manifold:sidebar-section-order", JSON.stringify(["nonsense", 7, null]));
  expect(initialSectionOrder()).toEqual(DEFAULT_SECTION_ORDER);
});

test("a retired id's collapsed state is inherited, and the live id's own state wins", () => {
  stored.set("manifold:sidebar-section-collapsed", JSON.stringify({ pads: true, machines: true }));
  expect(initialCollapsedSections()).toEqual({ views: true, machines: true });

  stored.set(
    "manifold:sidebar-section-collapsed",
    JSON.stringify({ pads: true, views: false, terminals: "yes" }),
  );
  expect(initialCollapsedSections()).toEqual({ views: false });
});

test("the merged stack still reorders as a permutation", () => {
  expect(moveSection(DEFAULT_SECTION_ORDER, "machines", 0)).toEqual([
    "machines",
    "views",
    "terminals",
  ]);
});
