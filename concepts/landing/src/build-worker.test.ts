import { afterAll, expect, test } from "bun:test";
import { type CountryRequest, countryBuild } from "./scenes/country/build.ts";
import { COUNTRY_MAP } from "./scenes/country/sim.ts";
import { type DewSpinRequest, dewSpin } from "./scenes/dew/sim.ts";
import { type FrostRequest, frostGrowth } from "./scenes/frost/sim.ts";
import { type PhysarumDishRequest, physarumDish } from "./scenes/physarum/sim.ts";
import {
  type BuildKind,
  type BuildMessage,
  BuildSlot,
  BuildWorker,
  type Landed,
} from "./sims/build.ts";
import { paramDefaults } from "./state.ts";
import { skyState } from "./world-clock.ts";

// The builds on the real build worker (this file's neighbour build-worker.ts, in a Bun worker,
// results transferred back) against the same builds run on the page: the same bytes, every typed
// array and every number. And the newest request wins: a superseded build never lands.

const worker = new Worker(new URL("./build-worker.ts", import.meta.url).href, { type: "module" });
/** What the page posted to the worker, in order. */
const posted: BuildMessage[] = [];
const post = worker.postMessage.bind(worker);
worker.postMessage = (message: BuildMessage) => {
  posted.push(message);
  post(message);
};
const builds = new BuildWorker(worker);

afterAll(() => worker.terminate());

/** A frame's budget on a fast display: what the renderer grants (SimFrame.budget). */
const FRAME_MS = 8;

/** The worker's next reply, once BuildWorker's own listener (set first) has taken it. */
function nextReply(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  worker.addEventListener("message", () => resolve(), { once: true });
  return promise;
}

/** Frames until the slot's build has landed finished, a frame after each of the worker's replies. */
async function finished<Result>(slot: BuildSlot<unknown, Result>): Promise<Landed<Result>[]> {
  const landed: Landed<Result>[] = [];
  for (;;) {
    const next = slot.advance(FRAME_MS);
    if (next) landed.push(next);
    if (next?.done) return landed;
    await nextReply();
  }
}

/** The paths where two results differ: typed arrays byte for byte, numbers bit for bit. */
function differences(a: unknown, b: unknown, path = "result", out: string[] = []): string[] {
  if (out.length >= 8) return out;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    const same =
      ArrayBuffer.isView(a) &&
      ArrayBuffer.isView(b) &&
      a.constructor === b.constructor &&
      Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
        Buffer.from(b.buffer, b.byteOffset, b.byteLength),
      );
    if (!same) out.push(path);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length`);
    else a.forEach((item, index) => differences(item, b[index], `${path}[${index}]`, out));
  } else if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    // Wall-clock stage timings are the one thing a build does not decide.
    keys.delete("timings");
    for (const key of keys)
      differences(Reflect.get(a, key), Reflect.get(b, key), `${path}.${key}`, out);
  } else if (!Object.is(a, b)) out.push(`${path}: ${String(a)} vs ${String(b)}`);
  return out;
}

/** The same request built on the worker (posted first, so it runs alongside) and on the page. */
async function bothWays<Request, Result>(
  kind: BuildKind<Request, Result>,
  request: Request,
): Promise<string[]> {
  const there = new BuildSlot(kind, builds);
  there.request("a", request);
  there.advance(FRAME_MS);
  const here = new BuildSlot(kind);
  here.request("a", request);
  // An Infinity budget runs to the end, stopping once at an early result (frost's quick field).
  let local = here.advance(Infinity);
  if (local && !local.done) local = here.advance(Infinity);
  if (!local?.done) throw new Error("a page build of Infinity budget did not finish");
  const remote = (await finished(there)).at(-1);
  there.dispose();
  return differences(remote?.result, local.result);
}

function country(seed: number): CountryRequest {
  return {
    options: { seed, size: COUNTRY_MAP.size, extent: COUNTRY_MAP.extent },
    uses: { shares: { crops: 60, woodland: 30, pasture: 25 }, pines: 0.25, cows: 0.5 },
    // The chalk M's open parcels and the river run dry along the way.
    chalk: seed === 1,
    water: seed !== 2,
    sky: skyState(paramDefaults("country").time ?? 0),
  };
}

for (const seed of [0, 1, 2, 3]) {
  test(`the countryside built on the worker is byte for byte the one built here, landscape ${seed}`, async () => {
    expect(await bothWays(countryBuild, country(seed))).toEqual([]);
  }, 60_000);
}

test("frost grown on the worker is byte for byte the frost grown here", async () => {
  const request: FrostRequest = { pattern: 3, size: { width: 512, height: 288 }, quick: true };
  expect(await bothWays(frostGrowth, request)).toEqual([]);
}, 60_000);

test("a dew web spun on the worker is byte for byte the web spun here", async () => {
  const air = { clock: 12.5, breeze: 0.6, gustAt: 10, gustAmp: 0.8 };
  for (const request of [
    { aspect: 1.6, seed: 2, air },
    { aspect: 9 / 16, seed: 0, air: { ...air, breeze: 0 } },
  ] satisfies DewSpinRequest[])
    expect(await bothWays(dewSpin, request)).toEqual([]);
}, 60_000);

test("a slime mould dish laid on the worker is byte for byte the dish laid here", async () => {
  for (const request of [
    { layout: "cities", seed: 1, aspect: 16 / 9, mark: undefined, agents: 40_960 },
    { layout: "random", seed: 4, aspect: 4 / 3, mark: 0.3, agents: 20_480 },
    { layout: "grid", seed: 2, aspect: 16 / 9, mark: undefined, agents: undefined },
  ] satisfies PhysarumDishRequest[])
    expect(await bothWays(physarumDish, request)).toEqual([]);
}, 60_000);

test("a build superseded on the worker never lands; the newest does", async () => {
  const slot = new BuildSlot(dewSpin, builds);
  const air = { clock: 0, breeze: 0.5, gustAt: -1e4, gustAmp: 1 };
  const from = posted.length;
  slot.request("wide", { aspect: 2, seed: 1, air });
  slot.advance(FRAME_MS);
  slot.request("tall", { aspect: 0.7, seed: 1, air });
  const landed = await finished(slot);
  expect(posted.slice(from).map((message) => message.type)).toEqual(["build", "cancel", "build"]);
  expect(landed.map(({ key }) => key)).toEqual(["tall"]);
  expect(landed[0]?.result.aspect).toBe(0.7);
  // Nor later: the worker answers in order, so a stray reply would come before the next build's.
  slot.request("again", { aspect: 1.2, seed: 1, air });
  expect((await finished(slot)).map(({ key }) => key)).toEqual(["again"]);
  slot.dispose();
}, 60_000);

test("a build superseded on the page never lands; the newest does", () => {
  const slot = new BuildSlot(frostGrowth);
  slot.request("first", { pattern: 1, size: { width: 256, height: 144 }, quick: true });
  // A slice of the first growth, as a frame with no time to spare runs it.
  expect(slot.advance(0, 1)).toBeUndefined();
  slot.request("second", { pattern: 2, size: { width: 256, height: 144 }, quick: false });
  const landed = slot.advance(Infinity);
  expect(landed?.key).toBe("second");
  expect(landed?.done).toBe(true);
  expect(slot.advance(Infinity)).toBeUndefined();
});
