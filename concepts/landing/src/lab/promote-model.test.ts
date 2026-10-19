import { describe, expect, test } from "bun:test";
import { composeScene, variantPreset } from "../composer/compose.ts";
import { encodeElements } from "../composer/elements.ts";
import { interior } from "../composer/interior.ts";
import type { Variant } from "../composer/types.ts";
import { readKnobs } from "../params.ts";
import { presets, type Preset } from "../presets.ts";
import { sillVariant } from "../scenes/sill/index.ts";
import { SILL_WINDOW } from "../scenes/sill/constants.ts";
import { readSetup } from "../state.ts";
import {
  namesBlocked,
  promote,
  promotionBlocked,
  suggestNames,
  variantEntry,
  type Promotion,
} from "./promote-model.ts";

const preset = (name: string, query: string): Preset => ({
  name,
  commit: "36bc94dd",
  query,
  savedAt: "2026-10-19",
});

/**
 * `query` promoted under the title and blurb it suggests and an id no scene will take (a real
 * promotion of the same preset may hold the suggested one), or the test fails.
 */
function promoted(query: string, name = "Sill · test") {
  const result: Promotion = promote(preset(name, query), {
    ...suggestNames(preset(name, query), []),
    id: "promotiontest",
  });
  if (!result.ok) throw new Error(`${query}: ${result.reason}`);
  return result;
}

/** The knobs `variant` composes at its defaults, keyed as in the URL. */
const knobsOf = (variant: Variant) =>
  readKnobs(
    composeScene(interior, variantPreset(interior.baseline, variant)).def.params,
    () => null,
  );

describe("promotion's fold", () => {
  test("folds a layer switched on into the layers added, in canonical order, and keeps the rest", () => {
    const { variant, room, entry } = promoted(
      "scene=sill&lavaLamp=1",
      "Sill · lava lamp on the sill",
    );
    expect(room).toBe("sill");
    expect(variant).toMatchObject({
      id: "promotiontest",
      base: "interior",
      title: "Lava lamp on the sill",
      accent: sillVariant.accent,
      look: sillVariant.look,
      passage: sillVariant.passage,
      planets: sillVariant.planets,
      groups: sillVariant.groups,
      layers: { add: ["props", "lavaLamp", "cat", "curtain"] },
      grade: sillVariant.grade,
      from: { commit: "36bc94dd", query: "scene=sill&lavaLamp=1" },
    });
    expect(variant.values).toBeUndefined();
    expect(entry).toBe(
      [
        "  promotiontest: {",
        '    id: "promotiontest",',
        '    base: "interior",',
        '    title: "Lava lamp on the sill",',
        '    blurb: "Sill: lava lamp on the sill.",',
        '    accent: "#ff3d7f",',
        '    look: { color: "full", levels: 4 },',
        "    ...identityOf(sillVariant),",
        '    layers: { add: ["props", "lavaLamp", "cat", "curtain"] },',
        "    grade: { ink: { gain: 1.15, gamma: 0.8 }, vignette: 0.28 },",
        '    from: { commit: "36bc94dd", query: "scene=sill&lavaLamp=1" },',
        "  },",
      ].join("\n"),
    );
  });

  test("folds a home layer switched off into the layers left out", () => {
    const { variant } = promoted("scene=sill&cat=0");
    expect(variant.layers).toEqual({ add: ["props", "curtain"] });
    const { variant: bare } = promoted("scene=lava&lavaLamp=0", "Lava lamp · empty");
    expect(bare.layers?.add).not.toContain("lavaLamp");
    expect(bare.layers?.remove).toEqual(["cityWindow"]);
  });

  test("folds the other knobs into values over the source's, less those the baseline holds", () => {
    const { variant } = promoted("scene=frost&time=0.8&snow=0&aurora=1", "Frost · dusk");
    // The frost pins its winter night, hour and snow; at the baseline's dusk and dry, they go.
    expect(variant.values?.time).toBeUndefined();
    expect(variant.values?.snow).toBeUndefined();
    expect(variant.values?.aurora).toBe(1);
    expect(knobsOf(variant)).toEqual(
      readSetup(new URLSearchParams("scene=frost&time=0.8&snow=0&aurora=1")).params,
    );
    const { variant: rain } = promoted(
      "scene=sill&rain=1&rain-amount=0.4&curtain-amount=0.25",
      "Sill · rain",
    );
    expect(rain.values).toEqual({ rain: 1, "rain-amount": 0.4, "curtain-amount": 0.25 });
  });

  test("folds the look and the accent into its identity, and elements= into its elements", () => {
    const { variant } = promoted("scene=sill&color=mono&levels=3&accent=%23123456");
    expect(variant.look).toEqual({ color: "mono", levels: 3 });
    expect(variant.accent).toBe("#123456");
    const lone = encodeElements([SILL_WINDOW]);
    const { variant: lit } = promoted(`scene=sill&elements=${lone}`);
    expect(lit.elements === undefined ? "" : encodeElements(lit.elements)).toBe(lone);
  });

  test("makes a variant whose defaults are its query's, for every committed room preset it may", () => {
    const rooms = presets.filter((entry) => promotionBlocked(entry) === undefined);
    expect(rooms.length).toBeGreaterThan(0);
    for (const entry of rooms) {
      const result = promote(entry, suggestNames(entry));
      expect({ name: entry.name, ok: result.ok }).toEqual({ name: entry.name, ok: true });
      if (!result.ok) continue;
      expect(knobsOf(result.variant)).toEqual(readSetup(new URLSearchParams(entry.query)).params);
      // No value it keeps is one the baseline holds already.
      for (const key of Object.keys(result.variant.values ?? {})) {
        const values = Object.fromEntries(
          Object.entries(result.variant.values ?? {}).filter(([other]) => other !== key),
        );
        expect({
          key,
          same: Bun.deepEquals(knobsOf({ ...result.variant, values }), knobsOf(result.variant)),
        }).toEqual({ key, same: false });
      }
    }
  });
});

describe("promotion is refused", () => {
  const reason = (query: string, names = suggestNames(preset("Sill · x", query))) => {
    const result = promote(preset("Sill · x", query), names);
    return result.ok ? "promoted" : result.reason;
  };

  test("for a scene that is not a room, or a preset that does not load as itself", () => {
    expect(reason("scene=country&time=0.3")).toMatch(/^not a room/);
    expect(reason("scene=sill&nonsense=1")).toMatch(/does not load as itself/);
    expect(reason("lavaLamp=1&scene=sill")).toMatch(/does not load as itself/);
    expect(reason("scene=mobile")).toMatch(/nothing of its own/);
  });

  test("for a key a variant cannot hold, naming it", () => {
    expect(reason("scene=sill&pixel=3&lavaLamp=1")).toBe(
      "a variant cannot hold pixel (a lab setting)",
    );
    // The planets' list (as compare.test.ts writes one) has no field in a variant yet.
    expect(reason("scene=frost&planets=AQEA")).toBe(
      "a variant cannot hold planets= (no variant field holds it)",
    );
  });

  test("for names that cannot name a new scene", () => {
    const names = { id: "silllava", title: "Lava lamp", blurb: "A lamp." };
    expect(namesBlocked(names, [])).toBeUndefined();
    expect(namesBlocked({ ...names, id: "sill" })).toBe("sill is a scene already");
    expect(namesBlocked({ ...names, id: "Sill-2" }, [])).toMatch(/lowercase letters only/);
    expect(namesBlocked({ ...names, title: " " }, [])).toBe("it needs a title");
    expect(reason("scene=sill&lavaLamp=1", { ...names, id: "lava" })).toBe(
      "lava is a scene already",
    );
  });
});

describe("the names it suggests", () => {
  test("take the name's part after its scene, and an id past those taken", () => {
    const lamp = preset("Sill · lava lamp on the sill", "scene=sill&lavaLamp=1");
    expect(suggestNames(lamp, [])).toEqual({
      id: "silllava",
      title: "Lava lamp on the sill",
      blurb: "Sill: lava lamp on the sill.",
    });
    expect(suggestNames(lamp, ["silllava", "silllavab"]).id).toBe("silllavac");
    expect(suggestNames(preset("my frost", "scene=frost&snow=0"), []).title).toBe("My frost");
  });

  test("an entry spells every difference it holds", () => {
    const { variant } = promoted("scene=frost&time=0.93&snow=0", "Frost · late");
    const entry = variantEntry(variant, "frost");
    for (const key of ["layers", "values", "camera", "room", "grade", "elements", "from"])
      expect({ key, spelt: entry.includes(`    ${key}: `) }).toEqual({ key, spelt: true });
    expect(entry).toContain("...identityOf(frostVariant),");
    expect(entry).not.toContain("passage");
  });
});
