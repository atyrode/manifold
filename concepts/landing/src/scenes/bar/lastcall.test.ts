import { expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { SceneSim, SimFrame } from "../types.ts";
import { barScene } from "./index.ts";
import { ACT, SEATS } from "./sim.ts";

const LAST_CALL = barScene.params.find((def) => def.key === "night")?.trigger ?? -1;

/** The bar's sim on a WebGL stand-in that keeps the texels it uploads, driven a frame at a time. */
class Evening {
  readonly #sim: SceneSim;
  readonly #frame: SimFrame;
  #texels = new Float32Array(0);

  constructor(knobs: Record<string, number>) {
    const gl = new Proxy({} as Record<string | symbol, unknown>, {
      get: (_, key) => {
        if (key === "texSubImage2D") return (...args: unknown[]) => void (this.#texels = (args[8] as Float32Array).slice());
        if (typeof key === "string" && /^[A-Z0-9_]+$/.test(key)) return 1;
        return () => ({});
      },
    }) as unknown as WebGL2RenderingContext;
    const sim = barScene.sim?.(gl);
    if (!sim) throw new Error("the bar has no sim");
    this.#sim = sim;
    this.#frame = {
      dt: 0, time: 0, motionTime: 0, motion: 1, width: 640, height: 360, aspect: 16 / 9,
      values: [], params: {}, triggers: Array.from({ length: 8 }, () => -1e4), fired: Array.from({ length: 8 }, () => false),
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      passage: { enter: 1, exit: 0 },
    };
    this.set(knobs);
    this.#sim.frame(this.#frame);
  }

  set(knobs: Record<string, number>): void {
    this.#frame.params = { ...this.#frame.params, ...knobs };
    this.#frame.values = barScene.params.map((def) => effective(def, this.#frame.params as Record<string, number>));
  }

  lastCall(): void {
    const triggers = this.#frame.triggers as number[];
    triggers[LAST_CALL] = this.#frame.time;
  }

  /** Run `seconds` in tenths, calling `each` after every frame. */
  run(seconds: number, each?: () => void): void {
    for (let i = 0; i < Math.round(seconds * 10); i++) {
      this.#frame.dt = 0.1;
      this.#frame.time += 0.1;
      this.#frame.motionTime += 0.1;
      this.#sim.frame(this.#frame);
      each?.();
    }
  }

  texel(i: number, c: number): number {
    return this.#texels[i * 4 + c] ?? Number.NaN;
  }

  get action(): number {
    return this.texel(0, 1);
  }

  get attending(): number {
    return this.texel(1, 3);
  }

  /** Seconds since last call was called; -1 before. */
  get sinceCall(): number {
    return this.texel(18, 3);
  }

  /** Look seeds of whoever is in the room (0: an empty stool), and how many are on their stools. */
  get seeds(): number[] {
    return Array.from({ length: SEATS }, (_, i) => this.texel(6 + i, 0));
  }

  get seated(): number {
    return Array.from({ length: SEATS }, (_, i) => this.texel(2 + i, 2)).filter((sit) => sit > 0.99).length;
  }
}

test("last call with nobody at the bar: he rings the bell as it is called, then comes over to you", () => {
  const bar = new Evening({ patrons: 0, bartender: 1 });
  bar.run(5);
  expect(bar.sinceCall).toBe(-1);
  bar.lastCall();
  let bellAt = Number.NaN;
  let calledAtBell = Number.NaN;
  let elapsed = 0;
  let cameOver = Number.NaN;
  bar.run(20, () => {
    elapsed += 0.1;
    if (Number.isNaN(bellAt) && bar.action === ACT.bell) {
      bellAt = elapsed;
      calledAtBell = bar.sinceCall;
    }
    if (Number.isNaN(cameOver) && bar.attending > 0.5) cameOver = elapsed;
  });
  // His hands were free (polishing): the bell within a second, and the lights' clock starts with it.
  expect(bellAt).toBeLessThan(1);
  expect(calledAtBell).toBeGreaterThanOrEqual(0);
  expect(calledAtBell).toBeLessThan(0.2);
  expect(cameOver).toBeGreaterThan(bellAt);
  expect(cameOver).toBeLessThan(12);
});

test("last call with the bartender off: the lights are flicked at once, no bell, and the room closes", () => {
  // The same evening without last call has newcomers within six minutes.
  const open = new Evening({ patrons: 3, bartender: 0 });
  const before = new Set(open.seeds.filter((seed) => seed > 0));
  let newcomers = 0;
  open.run(360, () => {
    for (const seed of open.seeds) if (seed > 0 && !before.has(seed)) newcomers++;
  });
  expect(newcomers).toBeGreaterThan(0);

  const bar = new Evening({ patrons: 3, bartender: 0 });
  bar.run(5);
  expect(bar.seated).toBe(3);
  const regulars = new Set(bar.seeds.filter((seed) => seed > 0));
  bar.lastCall();
  bar.run(0.1);
  expect(bar.sinceCall).toBeGreaterThanOrEqual(0);
  expect(bar.sinceCall).toBeLessThan(0.2);
  let bell = false;
  let strangers = 0;
  bar.run(360, () => {
    if (bar.action === ACT.bell) bell = true;
    for (const seed of bar.seeds) if (seed > 0 && !regulars.has(seed)) strangers++;
  });
  expect(bell).toBe(false);
  expect(strangers).toBe(0);
  // The room empties one by one: the last regular may still be finishing a drink.
  expect(bar.seated).toBeLessThanOrEqual(1);
  expect(bar.sinceCall).toBeGreaterThan(30);
});

test("moving the time of night after last call ends closing time", () => {
  const bar = new Evening({ patrons: 2, bartender: 0 });
  bar.run(2);
  bar.lastCall();
  bar.run(10);
  expect(bar.sinceCall).toBeGreaterThan(5);
  bar.set({ night: 0.32 });
  bar.run(0.1);
  expect(bar.sinceCall).toBe(-1);
});
