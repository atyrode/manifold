import { describe, expect, test } from "bun:test";
import { KnobReader } from "../params.ts";
import { frostComposed } from "../scenes/frost/index.ts";
import { loadScene } from "../scenes/index.ts";
import { HeadlessSim } from "../sims/headless.ts";
import { allocate } from "./sim.ts";

// In the frost two layers read a knob by the short key `mark`: the lava lamp holds `mark` (its M of
// wax), and the frost glass's own (its traced M) is qualified `frostGlassMark`, listed after it.
const { def, shortParams } = frostComposed;
const OWN = { lavaLamp: "mark", frostGlass: "frostGlassMark" } as const;

describe("a layer's short keys", () => {
  test("resolve to the layer's own knob, never to another layer's under the same key", () => {
    for (const [layer, key] of Object.entries(OWN)) {
      const view = shortParams[layer] ?? [];
      const own = def.params.findIndex((knob) => knob.key === key);
      expect({ layer, at: view.findIndex((knob) => knob.key === "mark") }).toEqual({
        layer,
        at: own,
      });
      const trigger = def.params[own]?.trigger;
      expect(trigger).toBeDefined();
      expect({ layer, trigger: new KnobReader(layer, view, ["mark"]).trigger("mark") }).toEqual({
        layer,
        trigger: trigger ?? -1,
      });
    }
    // The lava lamp's `mark`, which the frost glass's own shadows, under its holder's qualified key.
    const lamp = def.params.findIndex((knob) => knob.key === "mark");
    expect(shortParams["frostGlass"]?.[lamp]?.key).toBe("lavaLampMark");
  });

  test("the frost glass's traced M answers its own 'now', not the lava lamp's", async () => {
    const frost = await loadScene("frost");
    // The frost glass's field 1, the melt, at the frost's defaults.
    const melt =
      allocate(frostComposed.place(new Set(frostComposed.preset.layers)).layers.map((p) => p.layer))
        .fields["frostGlass"]?.[1] ?? -1;
    /** Melt texels a press of `key`'s "now" changes over a second, the pointer off the glass. */
    const traced = (key: string): number => {
      const sim = new HeadlessSim(frost);
      try {
        for (let f = 0; f < 6; f++)
          sim.step({ dt: f === 0 ? 0 : 0.05, pointer: { inside: false } });
        const before = sim.upload(melt).data.slice();
        sim.step({ dt: 0.05, now: [key], pointer: { inside: false } });
        for (let f = 0; f < 20; f++) sim.step({ dt: 0.05, pointer: { inside: false } });
        const after = sim.upload(melt).data;
        return after.filter((value, i) => value !== before[i]).length;
      } finally {
        sim.dispose();
      }
    };
    expect(traced("frostGlassMark")).toBeGreaterThan(0);
    expect(traced("mark")).toBe(0);
  });
});
