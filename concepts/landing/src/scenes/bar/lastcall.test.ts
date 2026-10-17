import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { ACT, SEATS } from "./sim.ts";

const barScene = await loadScene("bar");

/** The bar's sim on the headless stand-in, driven a frame at a time, the pointer away. */
class Evening {
  readonly #sim = new HeadlessSim(barScene);
  #knobs: Record<string, number>;
  #now: string[] = [];

  constructor(knobs: Record<string, number>) {
    this.#knobs = knobs;
    this.#sim.step(this.#frame(0));
  }

  set(knobs: Record<string, number>): void {
    this.#knobs = { ...this.#knobs, ...knobs };
  }

  /** Last call ("now" on the time of night), felt on the next frame. */
  lastCall(): void {
    this.#now = ["night"];
  }

  /** Run `seconds` in tenths, calling `each` after every frame. */
  run(seconds: number, each?: () => void): void {
    for (let i = 0; i < Math.round(seconds * 10); i++) {
      this.#sim.step(this.#frame(0.1));
      each?.();
    }
  }

  texel(i: number, c: number): number {
    return this.#sim.upload(0).data[i * 4 + c] ?? Number.NaN;
  }

  #frame(dt: number): HeadlessFrame {
    const now = this.#now;
    this.#now = [];
    return { dt, aspect: 16 / 9, height: 360, knobs: this.#knobs, now, pointer: { inside: false } };
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
    return Array.from({ length: SEATS }, (_, i) => this.texel(2 + i, 2)).filter((sit) => sit > 0.99)
      .length;
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
