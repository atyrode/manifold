import { describe, expect, test } from "bun:test";
import {
  LAST_CREATOR_KEY,
  creatorFace,
  recallCreator,
  rememberCreator,
  type CreatorStorage,
} from "../src/creator-choice.ts";

/**
 * THE FACE OF THE CREATION CONTROL (#1079): the last pick on this device while it is still
 * offered to this reader, otherwise the first entry offered. The offered list is already
 * filtered (owner enabled, own setting not false), so "hidden", "disabled", "uninstalled" and
 * "never a creator" all arrive here as the same case: not in the list.
 */
describe("creatorFace", () => {
  const offered = [{ id: "new-canvas" }, { id: "new-composition" }, { id: "new-folder" }];

  test("the remembered pick is the face while it is offered", () => {
    expect(creatorFace(offered, "new-folder")?.id).toBe("new-folder");
  });

  test("no memory, or a pick no longer offered, falls back to the first entry", () => {
    expect(creatorFace(offered, null)?.id).toBe("new-canvas");
    expect(creatorFace(offered, "a-stranger-entry")?.id).toBe("new-canvas");
    // The pick was hidden: the face falls back, and returns when the entry does.
    expect(creatorFace(offered.slice(0, 2), "new-folder")?.id).toBe("new-canvas");
  });

  test("nothing offered is no face at all, so the control is absent", () => {
    expect(creatorFace([], "new-folder")).toBeNull();
  });
});

describe("creator memory", () => {
  const memory = (): CreatorStorage & { readonly items: Map<string, string> } => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => void items.set(key, value),
    };
  };
  const broken: CreatorStorage = {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };

  test("a pick round-trips under its registered key", () => {
    const storage = memory();
    expect(recallCreator(storage)).toBeNull();
    rememberCreator(storage, "new-folder");
    expect(storage.items.get(LAST_CREATOR_KEY)).toBe("new-folder");
    expect(recallCreator(storage)).toBe("new-folder");
  });

  test("a storage fault is no memory, never a broken control", () => {
    expect(recallCreator(broken)).toBeNull();
    expect(() => rememberCreator(broken, "new-folder")).not.toThrow();
  });
});
