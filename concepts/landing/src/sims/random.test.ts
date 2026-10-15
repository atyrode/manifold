import { expect, test } from "bun:test";
import { mulberry32, Random } from "./random.ts";

test("a seed draws the numbers the scenes' own copies drew, so seeded layouts stay put", () => {
  // Ripple's drips (0x5eed) and the bar's evening (0x6ba7), as their copies drew them before moving here.
  const drips = mulberry32(0x5eed);
  expect([drips(), drips(), drips(), drips()]).toEqual([0.7100320369936526, 0.286336648510769, 0.9519026265479624, 0.10175976227037609]);
  const evening = new Random(0x6ba7);
  expect([evening.next(), evening.next(), evening.range(30, 200)]).toEqual([0.3954159286804497, 0.8213298150803894, 188.34807569393888]);
});

test("wait draws Street's Poisson gaps as its own copy did, and nothing at a rate of 0", () => {
  // Street's city layout seed (0x0c17e5), as its Random drew it before moving here.
  const city = new Random(0x0c17e5);
  expect([city.next(), city.range(4, 9), city.wait(0.25), city.wait(2)]).toEqual([0.39340261183679104, 5.002551838755608, 3.7260617859390592, 0.656976224921916]);
  const never = new Random(0x0c17e5);
  expect(never.wait(0)).toBe(Number.POSITIVE_INFINITY);
  expect(never.wait(-1)).toBe(Number.POSITIVE_INFINITY);
  expect(never.next()).toBe(0.39340261183679104);
});

test("Random is mulberry32 re-seeded in place, and a seed counts by its low 32 bits", () => {
  const random = new Random(7);
  const generator = mulberry32(7);
  const first = [random.next(), random.next(), random.next()];
  expect(first).toEqual([generator(), generator(), generator()]);
  random.seed(7);
  expect([random.next(), random.next(), random.next()]).toEqual(first);
  expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
});
