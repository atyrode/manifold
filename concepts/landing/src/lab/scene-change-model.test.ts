import { describe, expect, test } from "bun:test";
import { sceneIds } from "../scenes/index.ts";
import { sceneChange } from "./scene-change-model.ts";
import { sceneBaseline, shareBaseline } from "./tree-model.ts";

describe("shareBaseline", () => {
  test("a baseline and its variants, and any two variants of one baseline, share it", () => {
    expect(shareBaseline("room", "sill")).toBe(true);
    expect(shareBaseline("sill", "lava")).toBe(true);
    expect(shareBaseline("meadow", "land")).toBe(true);
    expect(shareBaseline("meadow", "autumn")).toBe(true);
    expect(shareBaseline("pond", "tidepool")).toBe(true);
  });

  test("two baselines' scenes, or a standalone one, do not", () => {
    expect(shareBaseline("sill", "meadow")).toBe(false);
    expect(shareBaseline("room", "land")).toBe(false);
    expect(shareBaseline("pond", "orbit")).toBe(false);
    expect(shareBaseline("orbit", "orbit")).toBe(false);
    expect(shareBaseline("orbit", "fractal")).toBe(false);
  });

  test("every scene is its baseline's, its own as a baseline, or standalone", () => {
    for (const id of sceneIds) {
      const baseline = sceneBaseline(id);
      if (baseline !== undefined) expect(sceneBaseline(baseline)).toBe(baseline);
    }
    expect(sceneBaseline("patch")).toBe("patch");
    expect(sceneBaseline("tidepool")).toBe("patch");
    expect(sceneBaseline("orbit")).toBeUndefined();
  });
});

describe("sceneChange", () => {
  test("by hand within a baseline, the world stays and the pictures blend, keep or not", () => {
    for (const keep of [false, true]) {
      expect(sceneChange("room", "sill", "hand", keep)).toEqual({
        keepWorld: true,
        crossfade: true,
      });
      expect(sceneChange("meadow", "land", "hand", keep)).toEqual({
        keepWorld: true,
        crossfade: true,
      });
    }
  });

  test("by hand across baselines, or to or from a standalone scene, only keep keeps the world", () => {
    for (const [from, to] of [
      ["sill", "meadow"],
      ["pond", "orbit"],
    ] as const) {
      expect(sceneChange(from, to, "hand", false)).toEqual({ keepWorld: false, crossfade: false });
      expect(sceneChange(from, to, "hand", true)).toEqual({ keepWorld: true, crossfade: false });
    }
  });

  test("a tour brings its own world and plays the passage, within a baseline too", () => {
    for (const by of ["tour", "advance"] as const)
      for (const keep of [false, true])
        expect(sceneChange("sill", "lava", by, keep)).toEqual({
          keepWorld: false,
          crossfade: false,
        });
  });
});
