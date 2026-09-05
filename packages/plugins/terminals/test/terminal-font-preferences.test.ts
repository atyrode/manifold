import { describe, expect, test } from "bun:test";
import {
  createTerminalFontPreferences,
  TERMINAL_FONT_SIZES_KEY,
} from "../src/terminal-font-preferences.ts";

function storageWith(raw = "{}") {
  let saved = raw;
  return {
    getItem: (_key: string) => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
}

describe("device-local terminal font preferences", () => {
  test("clamps changes to native integer pixel bounds and rejects non-finite values", () => {
    const preferences = createTerminalFontPreferences(storageWith());
    preferences.set("a", 100);
    expect(preferences.get("a")).toBe(32);
    preferences.set("a", -10);
    expect(preferences.get("a")).toBe(8);
    preferences.set("a", 17.7);
    preferences.set("a", Number.NaN);
    preferences.set("a", Number.POSITIVE_INFINITY);
    expect(preferences.get("a")).toBe(18);
  });

  test("ignores malformed storage and invalid entries without losing valid terminal preferences", () => {
    const storage = storageWith('{"a":20,"b":33,"c":"18","d":7,"e":12.5}');
    const preferences = createTerminalFontPreferences(storage);
    expect(["a", "b", "c", "d", "e"].map((id) => preferences.get(id))).toEqual([
      20, 13, 13, 13, 13,
    ]);
    for (const malformed of ["not json", "null", "[]", "42"]) {
      storage.setItem(TERMINAL_FONT_SIZES_KEY, malformed);
      preferences.reload();
      expect(preferences.get("a")).toBe(13);
    }
  });

  test("publishes sibling observations while keeping different terminals isolated across reload", () => {
    const storage = storageWith();
    const preferences = createTerminalFontPreferences(storage);
    const observed: number[] = [];
    const unsubscribe = preferences.subscribe(() => observed.push(preferences.get("a")));
    preferences.set("a", 18);
    preferences.set("b", 23);
    unsubscribe();
    preferences.set("a", 19);
    expect(observed).toEqual([18, 18]);
    const reloaded = createTerminalFontPreferences(storage);
    expect(reloaded.get("a")).toBe(19);
    expect(reloaded.get("b")).toBe(23);
    storage.setItem(TERMINAL_FONT_SIZES_KEY, '{"a":22,"b":23}');
    preferences.reload();
    expect(preferences.get("a")).toBe(22);
    expect(preferences.get("b")).toBe(23);
  });

  test("reset removes only the target terminal override durably", () => {
    const storage = storageWith('{"a":20,"b":18}');
    const preferences = createTerminalFontPreferences(storage);
    preferences.set("a", 13);
    expect(createTerminalFontPreferences(storage).get("a")).toBe(13);
    expect(preferences.get("b")).toBe(18);
    expect(JSON.parse(storage.getItem(TERMINAL_FONT_SIZES_KEY))).toEqual({ b: 18 });
  });

  test("prunes oldest updates on load and write while retaining recently adjusted terminals", () => {
    const initial = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`t${index}`, 18]),
    );
    const storage = storageWith(JSON.stringify(initial));
    const preferences = createTerminalFontPreferences(storage);
    expect(preferences.get("t0")).toBe(13);
    expect(preferences.get("t1")).toBe(13);
    preferences.set("t2", 19);
    preferences.set("new", 22);
    expect(preferences.get("t2")).toBe(19);
    expect(preferences.get("t3")).toBe(13);
    expect(createTerminalFontPreferences(storage).get("new")).toBe(22);
    expect(Object.keys(JSON.parse(storage.getItem(TERMINAL_FONT_SIZES_KEY)))).toHaveLength(128);
  });

  test("unavailable storage still applies the font and exposes write failure for notices", () => {
    const preferences = createTerminalFontPreferences({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    let observed = 0;
    preferences.subscribe(() => {
      observed = preferences.get("a");
    });
    expect(() => preferences.set("a", 17)).toThrow("quota exceeded");
    expect(preferences.get("a")).toBe(17);
    expect(observed).toBe(17);
  });
});
