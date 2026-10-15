// Seeded randomness for sims: mulberry32, so a seed knob always lays out the same arrangement.
//
//   mulberry32(seed)     a generator: each call returns the next number in [0, 1)
//   new Random(seed = 0) the same generator as an object that re-seeds in place (no closure per seed)
//     seed(seed)         restart the sequence at `seed`
//     next()             the next number in [0, 1)
//     range(lo, hi)      lo + (hi - lo) · next()
//     int(n)             a whole number in [0, n): floor(next() · n)
//     pick(items)        one of `items`, by int(items.length); throws RandomError when empty
//     wait(rate)         seconds to the next event of a Poisson process at `rate` per second:
//                        -ln(1 - next()) / rate, Infinity (and no draw) for a rate of 0 or less
//     gauss()            roughly normal, mean 0 and standard deviation 1: twice the sum of three
//                        draws less 1.5, so never beyond ±3 (lake's crack walks)
//
// A seed is taken as its low 32 bits (`seed >>> 0`), and both forms give the identical sequence for
// the identical seed, bit for bit the same as the copies the scenes carried, so existing seeds keep
// their layouts. Mix a knob into a seed at the call site, e.g.
// `Math.imul(knob + 1, 0x9e3779b1) ^ 0x6f1e5a3`.
//
// Usage:
//   const rand = mulberry32(Math.imul(seed + 1, 0x9e3779b1));
//   const x = rand();
//   // or, kept on the sim and re-seeded when the seed knob changes:
//   readonly #random = new Random();
//   this.#random.seed(seed);
//   const count = 3 + this.#random.int(3);

export class RandomError extends Error {}

/** A mulberry32 generator seeded with the low 32 bits of `seed`: each call returns the next number in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** mulberry32 as an object: the same sequence as `mulberry32(seed)`, re-seeded in place. */
export class Random {
  #state = 0;

  constructor(seed = 0) {
    this.seed(seed);
  }

  /** Restart the sequence at the low 32 bits of `seed`. */
  seed(seed: number): void {
    this.#state = seed >>> 0;
  }

  /** The next number in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A number in [lo, hi): lo + (hi - lo) · next(). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** A whole number in [0, n): floor(next() · n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** One of `items`, by int(items.length). */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new RandomError("random: nothing to pick from");
    return item;
  }

  /** Seconds to the next event of a Poisson process at `rate` per second; Infinity, drawing nothing, when `rate` <= 0. */
  wait(rate: number): number {
    return rate > 0 ? -Math.log(1 - this.next()) / rate : Number.POSITIVE_INFINITY;
  }

  /** Roughly normal, mean 0 and standard deviation 1: (three draws summed − 1.5) · 2, never beyond ±3. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}
