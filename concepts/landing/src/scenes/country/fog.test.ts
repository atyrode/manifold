import { expect, test } from "bun:test";
import { generateTerrain, packTerrain, TERRAIN_RECORDS } from "../../sims/terrain.ts";
import { COUNTRY_FOG, packCountryFog } from "./fog.ts";

const HEADER = 4 * (TERRAIN_RECORDS.misc * TERRAIN_RECORDS.width + COUNTRY_FOG.column);

test("the fog's floor follows the river down its valley, never rising, in its own texels only", () => {
  for (const base of ["valley", "coast", "plateau", "hills"] as const) {
    const terrain = generateTerrain({ seed: 0, size: 128, base });
    const packed = packTerrain(terrain);
    const before = packed.records.slice();
    packCountryFog(packed, terrain);
    const record = Array.from(packed.records.subarray(HEADER, HEADER + 4 + COUNTRY_FOG.samples));
    const [ax = 0, az = 0, first = 0, last = 0] = record;
    expect(Math.hypot(ax, az)).toBeCloseTo(1, 5);
    expect(last).toBeGreaterThan(first);
    const levels = record.slice(4);
    const river = Array.from(terrain.river.level);
    levels.forEach((level, i) => {
      if (i > 0) expect(level).toBeLessThanOrEqual(levels[i - 1] ?? Infinity);
      expect(level).toBeGreaterThanOrEqual(Math.min(...river));
      expect(level).toBeLessThanOrEqual(Math.max(...river));
    });
    // Down at the mouth's end it lies at the lowest the river comes to.
    expect(levels[levels.length - 1]).toBe(Math.min(...river));
    // Nothing else in the records moves.
    before.set(packed.records.subarray(HEADER, HEADER + 4 + COUNTRY_FOG.samples), HEADER);
    expect(packed.records).toEqual(before);
  }
});
