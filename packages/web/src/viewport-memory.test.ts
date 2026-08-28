import { describe, expect, test } from "bun:test";

import {
  decodeViewport,
  encodeViewport,
  loadViewport,
  saveViewport,
  viewportMemoryKey,
  type ViewportStorage,
} from "./viewport-memory.ts";

function fakeStorage(initial: Record<string, string> = {}): ViewportStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("viewport memory", () => {
  test("round-trips a viewport through storage per pad", () => {
    const storage = fakeStorage();
    saveViewport(storage, "pad-a", { x: -120.5, y: 44, zoom: 1.25 });
    saveViewport(storage, "pad-b", { x: 9, y: 9, zoom: 2 });
    expect(loadViewport(storage, "pad-a")).toEqual({ x: -120.5, y: 44, zoom: 1.25 });
    expect(loadViewport(storage, "pad-b")).toEqual({ x: 9, y: 9, zoom: 2 });
  });

  test("absent key loads as null", () => {
    expect(loadViewport(fakeStorage(), "pad")).toBeNull();
  });

  test.each([
    ["not json", "{{{"],
    ["not an object", "42"],
    ["null literal", "null"],
    ["missing fields", '{"x":1}'],
    ["non-numeric", '{"x":"1","y":2,"zoom":1}'],
    ["NaN", '{"x":null,"y":2,"zoom":1}'],
    ["infinite scroll", '{"x":1e999,"y":2,"zoom":1}'],
    ["zoom below supported minimum", '{"x":1,"y":2,"zoom":0.01}'],
    ["zoom above supported maximum", '{"x":1,"y":2,"zoom":31}'],
    ["zoom NaN", '{"x":1,"y":2,"zoom":"big"}'],
  ])("rejects garbage: %s", (_name, raw) => {
    expect(decodeViewport(raw)).toBeNull();
  });

  test("accepts zoom exactly at the bounds", () => {
    expect(decodeViewport('{"x":0,"y":0,"zoom":0.1}')).toEqual({ x: 0, y: 0, zoom: 0.1 });
    expect(decodeViewport('{"x":0,"y":0,"zoom":30}')).toEqual({ x: 0, y: 0, zoom: 30 });
  });

  test("encode drops extraneous fields", () => {
    const extra = { x: 1, y: 2, zoom: 3, junk: true } as unknown as Parameters<
      typeof encodeViewport
    >[0];
    expect(JSON.parse(encodeViewport(extra))).toEqual({ x: 1, y: 2, zoom: 3 });
  });

  test("throwing storage degrades to a no-op, never throws", () => {
    const broken: ViewportStorage = {
      getItem: () => {
        throw new Error("privacy mode");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(loadViewport(broken, "pad")).toBeNull();
    expect(() => {
      saveViewport(broken, "pad", { x: 0, y: 0, zoom: 1 });
    }).not.toThrow();
  });

  test("keys are pad-scoped", () => {
    expect(viewportMemoryKey("abc")).toBe("manifold:viewport:abc");
  });
});
