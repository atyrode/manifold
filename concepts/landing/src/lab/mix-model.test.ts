import { describe, expect, test } from "bun:test";
import { feature, range } from "../params.ts";
import { snap } from "./dom.ts";
import type { FeatureDef, RangeDef } from "./knobs.ts";
import {
  dividerDrag,
  setWeight,
  shareOf,
  spans,
  switchedOn,
  toggleIn,
  weightOf,
  type MixPart,
  type Read,
} from "./mix-model.ts";

const widget = (part: string) => ({ kind: "mix", mix: "land use", part, swatch: "#888" }) as const;

function rangePart(key: string, value: number): MixPart {
  const def = range("land", key, key, value, `${key} help`, {
    max: 100,
    step: 1,
    widget: widget(key),
  });
  if (def.kind !== "range") throw new Error("not a range");
  return { def: def satisfies RangeDef, part: key, swatch: "#888" };
}

function featurePart(key: string, on: boolean, value: number): MixPart {
  const def = feature("land", key, key, on, "share", value, `${key} help`, {
    min: 0,
    max: 100,
    step: 1,
    widget: widget(key),
  });
  if (def.kind !== "feature") throw new Error("not a feature");
  return { def: def satisfies FeatureDef, part: key, swatch: "#888" };
}

/** Each part's default URL values, as paramDefaults keys them. */
function defaultsOf(parts: readonly MixPart[]): Record<string, number> {
  return Object.fromEntries(
    parts.flatMap(({ def }) =>
      def.kind === "feature"
        ? [
            [def.key, def.on ? 1 : 0],
            [`${def.key}-amount`, def.value],
          ]
        : [[def.key, def.value]],
    ),
  );
}

/** A Read over `values`, falling back to the parts' defaults (Knobs.value). */
function reader(parts: readonly MixPart[], values: Record<string, number> = {}): Read {
  const defaults = defaultsOf(parts);
  return (key) => values[key] ?? defaults[key] ?? 0;
}

const names = (list: readonly { part: MixPart }[]) => list.map((span) => span.part.part);

describe("a mix with feature parts", () => {
  const crops = featurePart("crops", true, 40);
  const orchard = featurePart("orchard", false, 30);
  const pasture = featurePart("pasture", true, 60);
  const parts = [crops, orchard, pasture];

  test("a part that is off takes no share and no span, whatever its stored amount", () => {
    const read = reader(parts);
    expect(switchedOn(orchard, read)).toBe(false);
    expect(weightOf(orchard, read)).toBe(0);
    expect(shareOf(crops, parts, read)).toBeCloseTo(0.4);
    expect(shareOf(pasture, parts, read)).toBeCloseTo(0.6);
    expect(names(spans(parts, read))).toEqual(["crops", "pasture"]);
    const [first, second] = spans(parts, read);
    expect(first?.end).toBeCloseTo(0.4);
    expect(second?.start).toBeCloseTo(0.4);
    expect(second?.end).toBeCloseTo(1);
  });

  test("switching a part off keeps its amount, and switching it on brings that amount back", () => {
    const off = toggleIn(crops, parts, reader(parts), reader(parts));
    expect(off).toEqual({ crops: 0 });
    const read = reader(parts, off);
    expect(names(spans(parts, read))).toEqual(["pasture"]);
    const on = toggleIn(crops, parts, read, reader(parts));
    expect(on).toEqual({ crops: 1 });
    expect(weightOf(crops, reader(parts, { ...off, ...on }))).toBe(40);
    expect(toggleIn(orchard, parts, reader(parts), reader(parts))).toEqual({ orchard: 1 });
  });

  test("a part switched on at zero amount comes back with its default, else an even weight", () => {
    const stored = { "orchard-amount": 0 };
    expect(toggleIn(orchard, parts, reader(parts, stored), reader(parts))).toEqual({
      orchard: 1,
      "orchard-amount": 30,
    });
    const bare = featurePart("orchard", false, 0);
    const withBare = [crops, bare, pasture];
    expect(toggleIn(bare, withBare, reader(withBare), reader(withBare))).toEqual({
      orchard: 1,
      "orchard-amount": 50,
    });
  });

  test("a divider trades weight between its on-neighbours only, past the parts that are off", () => {
    const read = reader(parts);
    const trade = dividerDrag(parts, read, 0);
    if (!trade) throw new Error("no divider between crops and pasture");
    expect(trade.held).toEqual([crops, pasture]);
    const patch = trade.at(0.25);
    expect(patch).toEqual({ "crops-amount": 25, "pasture-amount": 75 });
    expect(patch).not.toContainKey("orchard");
    expect(patch).not.toContainKey("orchard-amount");
    expect(trade.release(patch)).toEqual(patch);
    expect(dividerDrag(parts, read, 1)).toBeUndefined();
  });

  test("every other part keeps its share while two neighbours trade", () => {
    const wheat = featurePart("wheat", true, 20);
    const four = [wheat, crops, orchard, pasture];
    const read = reader(four);
    const trade = dividerDrag(four, read, 1);
    if (!trade) throw new Error("no divider between crops and pasture");
    const patch = trade.at(0.5);
    expect(patch).toEqual({ "wheat-amount": 20, "crops-amount": 40, "pasture-amount": 60 });
    const moved = trade.at(0.25);
    expect(moved["wheat-amount"]).toBe(20);
    expect((moved["crops-amount"] ?? 0) + (moved["pasture-amount"] ?? 0)).toBe(100);
  });

  test("a part dragged to zero switches off on release, keeping the amount it had", () => {
    const trade = dividerDrag(parts, reader(parts), 0);
    if (!trade) throw new Error("no divider between crops and pasture");
    const closed = trade.at(0);
    expect(closed).toEqual({ "crops-amount": 0, "pasture-amount": 100 });
    // Held while dragged: still drawn at zero width until it is let go.
    const live = reader(parts, closed);
    expect(names(spans(parts, live, trade.held))).toEqual(["crops", "pasture"]);
    expect(names(spans(parts, live))).toEqual(["pasture"]);
    expect(trade.release(closed)).toEqual({
      crops: 0,
      "crops-amount": 40,
      "pasture-amount": 100,
    });
  });

  test("a mix may hold ranges and features: a range at zero is out, a feature off is out", () => {
    const hay = rangePart("hay", 0);
    const mixed = [hay, crops, orchard, pasture];
    const read = reader(mixed);
    expect(names(spans(mixed, read))).toEqual(["crops", "pasture"]);
    expect(toggleIn(hay, mixed, read, read)).toEqual({ hay: 50 });
    const trade = dividerDrag(mixed, read, 0);
    expect(trade?.at(0.5)).toEqual({ hay: 0, "crops-amount": 50, "pasture-amount": 50 });
  });

  test("the legend's keys set a feature's amount, and zero switches it off", () => {
    expect(setWeight(crops, 41.4)).toEqual({ "crops-amount": 41 });
    expect(setWeight(crops, 120)).toEqual({ "crops-amount": 100 });
    expect(setWeight(crops, 0)).toEqual({ crops: 0 });
    expect(setWeight(crops, -5)).toEqual({ crops: 0 });
  });
});

/**
 * The range-only mix as the widget computed it before feature parts: spans of the weights, a
 * divider drag writing every part, the cross's patches. Transcribed so the model is held to it.
 */
const before = {
  spans(weights: readonly number[]): { index: number; start: number; end: number }[] {
    const sum = weights.reduce((a, b) => a + b, 0);
    let start = 0;
    return weights
      .map((weight, index) => {
        const width = sum > 0 ? weight / sum : 0;
        const span = { index, start, end: start + width };
        start += width;
        return span;
      })
      .filter((span) => span.end > span.start);
  },
  drag(defs: readonly RangeDef[], weights: readonly number[], index: number, at: number) {
    const shown = before.spans(weights);
    const left = shown[index];
    const right = shown[index + 1];
    if (!left || !right) return undefined;
    const sum = weights.reduce((a, b) => a + b, 0);
    const into = Math.min(right.end, Math.max(left.start, at));
    const next = [...weights];
    next[left.index] = (into - left.start) * sum;
    next[right.index] = (right.end - into) * sum;
    const over = Math.max(...defs.map((def, i) => (next[i] ?? 0) / def.max));
    const scale = over > 1 ? 1 / over : 1;
    return Object.fromEntries(
      defs.map((def, i) => [def.key, snap((next[i] ?? 0) * scale, def.min, def.max, def.step)]),
    );
  },
  toggle(defs: readonly RangeDef[], weights: readonly number[], index: number) {
    const def = defs[index];
    if (!def) throw new Error("no part");
    if ((weights[index] ?? 0) > 0) return { [def.key]: def.min };
    const others = weights.filter((weight) => weight > 0);
    const mean =
      others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : def.max / 2;
    return { [def.key]: snap(mean, def.min, def.max, def.step) };
  },
};

/** mulberry32: a repeatable sequence for the comparison. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("a mix of ranges alone behaves exactly as it did before feature parts", () => {
  const next = random(1082);
  for (let round = 0; round < 400; round++) {
    const count = 2 + Math.floor(next() * 5);
    const weights = Array.from({ length: count }, () =>
      next() < 0.3 ? 0 : Math.round(next() * 100),
    );
    const parts = weights.map((weight, i) => rangePart(`part${i}`, weight));
    const defs = parts.map(({ def }) => {
      if (def.kind !== "range") throw new Error("not a range");
      return def;
    });
    const read = reader(parts);
    const shown = spans(parts, read);
    expect(shown.map((span) => [span.part.def.key, span.start, span.end])).toEqual(
      before.spans(weights).map((span) => [`part${span.index}`, span.start, span.end]),
    );
    const index = Math.floor(next() * count);
    const at = next() * 1.2 - 0.1;
    const trade = dividerDrag(parts, read, index);
    const expected = before.drag(defs, weights, index, at);
    if (expected === undefined) expect(trade).toBeUndefined();
    else {
      const patch = trade?.at(at);
      expect(patch).toEqual(expected);
      if (patch) expect(trade?.release(patch)).toEqual(expected);
    }
    const part = parts[index];
    if (!part) throw new Error("no part");
    expect(toggleIn(part, parts, read, read)).toEqual(before.toggle(defs, weights, index));
    expect(setWeight(part, (weights[index] ?? 0) - 7)).toEqual({
      [part.def.key]: snap((weights[index] ?? 0) - 7, 0, 100, 1),
    });
  }
});

test("past their maximum, every range scales down together so the shares come out as dragged", () => {
  const parts = [rangePart("a", 100), rangePart("b", 100)];
  const trade = dividerDrag(parts, reader(parts), 0);
  expect(trade?.at(0.75)).toEqual({ a: 100, b: 33 });
});
