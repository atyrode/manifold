import { expect, test } from "bun:test";
import { HeadlessGl, HeadlessSim } from "../../sims/headless.ts";
import { countryScene } from "./index.ts";
import { COUNTRY_MAP } from "./sim.ts";

// The countryside's stages keyed by what they read: a land-use change re-allocates and repacks only
// the parcels it moves, on the terrain already built. On the headless stand-in, which also counts
// the texel rows each texture is sent.

/** The country sim on a stand-in context, and the rows sent to each texture since `clear()`. */
function counted(): { sim: HeadlessSim; headless: HeadlessGl; rows: Map<WebGLTexture, number> } {
  const headless = new HeadlessGl();
  // The stand-in's own calls, wrapped to see which texture each upload lands in.
  const context = headless.gl as unknown as {
    bindTexture(target: number, texture: WebGLTexture | null): void;
    texSubImage2D(...args: unknown[]): void;
  };
  const bind = context.bindTexture;
  const upload = context.texSubImage2D;
  const rows = new Map<WebGLTexture, number>();
  let bound: WebGLTexture | null = null;
  context.bindTexture = (target, texture) => {
    bound = texture;
    bind(target, texture);
  };
  context.texSubImage2D = (...args) => {
    if (bound) rows.set(bound, (rows.get(bound) ?? 0) + Number(args[5]));
    upload(...args);
  };
  return { sim: new HeadlessSim(countryScene, headless.gl), headless, rows };
}

const same = (a: Float32Array | Uint8Array, b: Float32Array | Uint8Array): boolean =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );

test("a land-use change reuses the terrain and repacks only the parcels it moves", () => {
  const { sim, headless, rows } = counted();
  const [ground, cover, parcels, records] = sim.frame();
  if (!ground || !cover || !parcels || !records) throw new Error("the countryside built nothing");
  // A one-point share step, pasture switched on, then the herds alone, which move no wood.
  const steps: { knobs: Record<string, number>; narrow?: true; herds?: true }[] = [
    { knobs: { "crops-amount": 59 }, narrow: true },
    { knobs: { "crops-amount": 59, pasture: 1 } },
    { knobs: { "crops-amount": 59, pasture: 1, cows: 0.9 }, herds: true },
  ];
  for (const { knobs, narrow, herds } of steps) {
    const was = headless.upload(parcels).data;
    rows.clear();
    sim.frame({ knobs });
    // No terrain stage ran: the ground is not sent again.
    expect(rows.get(ground)).toBeUndefined();
    // The cover goes as the band of rows the moved parcels span; a share step's is not the map.
    expect(rows.get(cover)).toBeGreaterThan(0);
    if (narrow) expect(rows.get(cover)).toBeLessThan(COUNTRY_MAP.size);
    // The parcels' map goes only as the band of rows whose species flags changed, if any: none
    // for the herds.
    const now = headless.upload(parcels).data;
    let first: number = COUNTRY_MAP.size;
    let last = -1;
    for (let k = 0; k < now.length; k++) {
      if (now[k] === was[k]) continue;
      first = Math.min(first, Math.floor(k / (4 * COUNTRY_MAP.size)));
      last = Math.max(last, Math.floor(k / (4 * COUNTRY_MAP.size)));
    }
    expect(rows.get(parcels)).toBe(last < 0 ? undefined : last - first + 1);
    if (herds) expect(rows.get(parcels)).toBeUndefined();
    // And it is byte for byte the land a build made with these knobs from the start packs.
    const fresh = new HeadlessSim(countryScene).step({ knobs });
    expect(same(headless.upload(cover).data, fresh.upload(1).data)).toBe(true);
    expect(same(now, fresh.upload(2).data)).toBe(true);
    expect(same(headless.upload(records).data, fresh.upload(3).data)).toBe(true);
    fresh.dispose();
  }
  sim.dispose();
}, 120_000);

test("a terrain change builds the terrain again", () => {
  const { sim, rows } = counted();
  const [ground] = sim.frame();
  if (!ground) throw new Error("the countryside built nothing");
  rows.clear();
  sim.frame({ knobs: { relief: 0.6 } });
  expect(rows.get(ground)).toBe(COUNTRY_MAP.size);
  sim.dispose();
}, 60_000);
