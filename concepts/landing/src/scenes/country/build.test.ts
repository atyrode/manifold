import { expect, test } from "bun:test";
import { transferables } from "../../sims/build.ts";
import type { TerrainOptions } from "../../sims/terrain.ts";
import { skyState } from "../../world-clock.ts";
import { type CountryBuilt, countryBuild, type CountryRequest } from "./build.ts";
import { buildCountry, builtHashes } from "./engines.ts";

// One builder's builds, one after another as the knobs turn, against a fresh builder's: byte for
// byte the same. A settlement or road changed keeps the land and river's stages (terrain.ts's
// Carved, landuse.ts's landGround); a river changed keeps only the relief, and the next change
// keeps the new river's. Each result is first handed away as the worker hands it to the page (its
// buffers transferred), so nothing a builder keeps may be shared with it.

const sky = skyState(0.68);

function request(change: Partial<TerrainOptions>): CountryRequest {
  return {
    options: { seed: 3, ...change },
    uses: { shares: { crops: 60, woodland: 30, pasture: 25 }, pines: 0.25, cows: 0.5 },
    chalk: true,
    water: true,
    sky,
  };
}

/** Hand `built` away by transfer, leaving its buffers detached here. */
function transfer(built: CountryBuilt): void {
  structuredClone(built, { transfer: transferables(built) });
}

test("a kept builder builds what a fresh one does, change after change", () => {
  const kept = countryBuild.builder();
  const first = buildCountry(request({}), kept);
  const sought = first.terrain.timings.settlements ?? 0;
  transfer(first);
  const changes: readonly Partial<TerrainOptions>[] = [
    { farms: 4 },
    { farms: 4, castle: false },
    { farms: 4, roads: false },
    { river: 0.55 },
    { river: 0.55, hamlets: 3 },
  ];
  let river = 0.5;
  for (const change of changes) {
    const asked = request(change);
    const again = buildCountry(asked, kept);
    const fresh = buildCountry(asked);
    expect({ change, parts: builtHashes(again) }).toEqual({ change, parts: builtHashes(fresh) });
    // The settlements' sites of a kept land and river are not sought again.
    const same = (change.river ?? 0.5) === river;
    river = change.river ?? 0.5;
    if (same) expect(again.terrain.timings.settlements ?? 0).toBeLessThan(0.25 * sought);
    transfer(again);
  }
}, 60_000);
