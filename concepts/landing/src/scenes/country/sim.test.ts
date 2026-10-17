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

test("a land-use share change reuses the terrain and repacks only the parcels it moves", () => {
  const { sim, headless, rows } = counted();
  const [ground, cover, parcels, records] = sim.frame();
  if (!ground || !cover || !parcels || !records) throw new Error("the countryside built nothing");
  const share = { "crops-amount": 45 };
  rows.clear();
  sim.frame({ knobs: share });
  // No terrain stage ran: the ground is not sent again.
  expect(rows.get(ground)).toBeUndefined();
  // The cover and the parcels' map (its pine flags) go as the band of rows the moved parcels span,
  // not the whole map.
  expect(rows.get(cover)).toBeGreaterThan(0);
  expect(rows.get(cover)).toBeLessThan(COUNTRY_MAP.size);
  expect(rows.get(parcels)).toBe(rows.get(cover));
  // And it is byte for byte the land a build made with that share from the start packs.
  const fresh = new HeadlessSim(countryScene).step({ knobs: share });
  const same = (a: Float32Array | Uint8Array, b: Float32Array | Uint8Array): boolean =>
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
      Buffer.from(b.buffer, b.byteOffset, b.byteLength),
    );
  expect(same(headless.upload(cover).data, fresh.upload(1).data)).toBe(true);
  expect(same(headless.upload(parcels).data, fresh.upload(2).data)).toBe(true);
  expect(same(headless.upload(records).data, fresh.upload(3).data)).toBe(true);
  sim.dispose();
  fresh.dispose();
}, 60_000);

test("a terrain change builds the terrain again", () => {
  const { sim, rows } = counted();
  const [ground] = sim.frame();
  if (!ground) throw new Error("the countryside built nothing");
  rows.clear();
  sim.frame({ knobs: { relief: 0.6 } });
  expect(rows.get(ground)).toBe(COUNTRY_MAP.size);
  sim.dispose();
}, 60_000);
