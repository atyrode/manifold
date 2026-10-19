import { expect, test } from "bun:test";
import { HeadlessGl, HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { COUNTRY_MAP } from "./sim.ts";

const countryScene = await loadScene("country");

// The valley's stages keyed by what they read: a land-use change re-allocates and repacks only the
// parcels it moves, on the terrain already built. On the headless stand-in, which also counts the
// texel rows each texture is sent. The composed sim binds the valley's four fields from slot 2.

/** The composed sim on a stand-in context, and the rows sent to each texture since `clear()`. */
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
  const [, , ground, cover, parcels, records] = sim.frame();
  if (!ground || !cover || !parcels || !records) throw new Error("the countryside built nothing");
  // A one-point share step, pasture switched on, then the herds alone, which move no texel.
  const steps: { knobs: Record<string, number>; narrow?: true; herds?: true }[] = [
    { knobs: { "crops-amount": 59 }, narrow: true },
    { knobs: { "crops-amount": 59, pasture: 1 } },
    { knobs: { "crops-amount": 59, pasture: 1, cows: 0.9 }, herds: true },
  ];
  // The band of rows, first to last, whose bytes differ between two uploads; 0 where none.
  const band = (was: Uint8Array | Float32Array, now: Uint8Array | Float32Array): number => {
    let first: number = COUNTRY_MAP.size;
    let last = -1;
    for (let k = 0; k < now.length; k++) {
      if (now[k] === was[k]) continue;
      first = Math.min(first, Math.floor(k / (4 * COUNTRY_MAP.size)));
      last = Math.max(last, Math.floor(k / (4 * COUNTRY_MAP.size)));
    }
    return last < 0 ? 0 : last - first + 1;
  };
  for (const { knobs, narrow, herds } of steps) {
    const was = { cover: headless.upload(cover).data, parcels: headless.upload(parcels).data };
    rows.clear();
    sim.frame({ knobs });
    // No terrain stage ran: the ground is not sent again.
    expect(rows.get(ground)).toBeUndefined();
    // The cover (the clearance, felled or not, and the lone trees) and the parcels' map (the
    // species flags) go only as the band of rows whose bytes changed, if any: a share step's band
    // of lone trees whose hedges came or went is not the map, and the herds change neither.
    const now = headless.upload(parcels).data;
    const covered = band(was.cover, headless.upload(cover).data);
    expect(rows.get(cover) ?? 0).toBe(covered);
    expect(rows.get(parcels) ?? 0).toBe(band(was.parcels, now));
    if (narrow) {
      expect(covered).toBeGreaterThan(0);
      expect(covered).toBeLessThan(COUNTRY_MAP.size);
    }
    if (herds) expect([rows.get(cover), rows.get(parcels)]).toEqual([undefined, undefined]);
    // And it is byte for byte the land a build made with these knobs from the start packs.
    const fresh = new HeadlessSim(countryScene).step({ knobs });
    expect(same(headless.upload(cover).data, fresh.upload(3).data)).toBe(true);
    expect(same(now, fresh.upload(4).data)).toBe(true);
    expect(same(headless.upload(records).data, fresh.upload(5).data)).toBe(true);
    fresh.dispose();
  }
  sim.dispose();
}, 120_000);

test("a terrain change builds the terrain again", () => {
  const { sim, rows } = counted();
  const [, , ground] = sim.frame();
  if (!ground) throw new Error("the countryside built nothing");
  rows.clear();
  sim.frame({ knobs: { valleyRelief: 0.6 } });
  expect(rows.get(ground)).toBe(COUNTRY_MAP.size);
  sim.dispose();
}, 60_000);
