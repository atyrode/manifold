import { describe, expect, test } from "bun:test";
import type { Pad } from "@manifold/protocol";
import {
  chooseInitialPad,
  forgetPad,
  padMemoryKey,
  rememberPad,
  type PadMemoryStorage,
} from "./pad-memory.ts";

function storage(initial: Record<string, string> = {}): PadMemoryStorage & {
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const PADS: readonly Pad[] = [
  { id: "first", name: "First", createdAt: 1, layout: "canvas", transient: false },
  { id: "latest", name: "Latest", createdAt: 2, layout: "canvas", transient: false },
];

describe("pad memory", () => {
  test("chooses a visible remembered pad", () => {
    const memory = storage({ [padMemoryKey("p1")]: "latest" });
    expect(chooseInitialPad(memory, "p1", PADS)?.id).toBe("latest");
  });

  test("falls back to the first server-listed pad", () => {
    const memory = storage({ [padMemoryKey("p1")]: "deleted" });
    expect(chooseInitialPad(memory, "p1", PADS)?.id).toBe("first");
    expect(chooseInitialPad(memory, "p1", [])).toBeNull();
  });

  test("forgets only the matching remembered pad", () => {
    const memory = storage();
    rememberPad(memory, "p1", "latest");
    forgetPad(memory, "p1", "first");
    expect(memory.data.get(padMemoryKey("p1"))).toBe("latest");
    forgetPad(memory, "p1", "latest");
    expect(memory.data.has(padMemoryKey("p1"))).toBe(false);
  });
});
