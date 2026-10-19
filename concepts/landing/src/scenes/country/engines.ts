// The countryside built in whatever engine runs this module, hashed part by part, for
// engines.test.ts: it builds the landscapes here (bun runs JavaScriptCore, Safari's engine) and has
// node run this file (V8, Chrome's), and the two must agree bit for bit, or a seed would lay out a
// different countryside in different browsers. The request is made in each engine as the page makes
// it (the sky weighed in at the scene's default hour), and nothing is committed: an intended change
// to the build changes both sides alike.
//
// A part hashes alone (FNV-1a over a typed array's bytes, a number's float64 bits, an object's
// fields in key order), so a difference names the part it is in: the terrain's and the packed
// textures' fields one by one, then the land model, its texels, the chalk M's site and the
// allocation. The terrain's stage timings are wall-clock and left out. build.test.ts compares a
// kept builder's builds with fresh ones by the same hashes.
//
// Run directly, it prints the hashes as JSON:
//   node --experimental-strip-types src/scenes/country/engines.ts
import { fileURLToPath } from "node:url";
import { skyState } from "../../world-clock.ts";
import { countryBuild, type CountryBuilt, type CountryRequest } from "./build.ts";

/** The builds compared: three landscapes, each another shape; the chalk M on, the river running. */
const ENGINE_BUILDS = [
  { seed: 0, base: "valley" },
  { seed: 3, base: "hills" },
  { seed: 5, base: "coast" },
] as const;

/** The scene's default hour (the `time` knob, index.ts), which the chalk M's site is weighed in. */
const HOUR = 0.68;

export class EngineHashError extends Error {}

const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const number = new DataView(new ArrayBuffer(8));
const text = new TextEncoder();

function fnv(bytes: Uint8Array, h: number): number {
  for (const byte of bytes) h = Math.imul(h ^ byte, FNV_PRIME);
  return h;
}

/** `value` folded into the hash `h` (see the header). */
function fold(value: unknown, h: number): number {
  if (ArrayBuffer.isView(value))
    return fnv(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), h);
  if (typeof value === "number") {
    number.setFloat64(0, value);
    return fnv(new Uint8Array(number.buffer), h);
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  )
    return fnv(text.encode(`${typeof value}:${String(value)}`), h);
  if (Array.isArray(value)) {
    h = fold(value.length, h);
    for (const item of value) h = fold(item, h);
    return h;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value).sort()) h = fold(Reflect.get(value, key), fold(key, h));
    return h;
  }
  throw new EngineHashError(`country engines: cannot hash a ${typeof value}`);
}

function hash(value: unknown): string {
  return (fold(value, FNV_BASIS) >>> 0).toString(16).padStart(8, "0");
}

/** `request` built to the end by `builder` (a fresh one unless given). */
export function buildCountry(
  request: CountryRequest,
  builder = countryBuild.builder(),
): CountryBuilt {
  const steps = builder.build(request);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** A build's parts by name, each by its hash (see the header). */
export function builtHashes(built: CountryBuilt): Record<string, string> {
  const hashes: Record<string, string> = {};
  const { terrain, packed, ...rest } = built;
  for (const [field, value] of Object.entries(terrain))
    if (field !== "timings") hashes[`terrain.${field}`] = hash(value);
  for (const [field, value] of Object.entries(packed)) hashes[`packed.${field}`] = hash(value);
  for (const [name, value] of Object.entries(rest)) hashes[name] = hash(value);
  return hashes;
}

/** ENGINE_BUILDS' hashes, in order. */
export function engineHashes(): Record<string, string>[] {
  const sky = skyState(HOUR);
  const uses = { shares: { crops: 60, woodland: 30, pasture: 25 }, pines: 0.25, cows: 0.5 };
  return ENGINE_BUILDS.map(({ seed, base }) =>
    builtHashes(buildCountry({ options: { seed, base }, uses, chalk: true, water: true, sky })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(engineHashes()));
