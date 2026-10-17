import { describe, expect, test } from "bun:test";
import { range, toggle, type ParamDef } from "../params.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import { paramDefaults, type Params } from "../state.ts";
import {
  available,
  groupShows,
  itemShows,
  narrow,
  shownChanges,
  switchChain,
  titleHolds,
  whenProblems,
  type LensGate,
  type LensQuery,
  type NarrowItem,
} from "./availability-model.ts";
import { knobKeys } from "./knobs.ts";
import { changedCounts, changedKnobs } from "./lens-model.ts";

const pond = sceneDefs.pond.params;

describe("switchChain", () => {
  test("a control hanging on nothing waits on nothing", () => {
    expect(switchChain(pond, undefined)).toEqual([]);
  });

  test("a chain is followed to any depth, nearest first", () => {
    // pond: personal space hangs on "drawn to mouse", which hangs on the koi.
    expect(switchChain(pond, "follow")).toEqual(["follow", "koi"]);
    const deep: ParamDef[] = [
      toggle("g", "a", "a", true, "help"),
      toggle("g", "b", "b", true, "help", { when: "a" }),
      toggle("g", "c", "c", true, "help", { when: "b" }),
      range("g", "d", "d", 0.5, "help", { when: "c" }),
    ];
    expect(switchChain(deep, deep[3]?.when)).toEqual(["c", "b", "a"]);
  });

  test("a key of no knob or a loop ends the chain", () => {
    const loop: ParamDef[] = [
      toggle("g", "a", "a", true, "help", { when: "b" }),
      toggle("g", "b", "b", true, "help", { when: "a" }),
    ];
    expect(switchChain(loop, "a")).toEqual(["a", "b"]);
    expect(switchChain(pond, "!ring")).toEqual(["!ring"]);
  });
});

describe("available", () => {
  const on = (params: Params) => (key: string) => (params[key] ?? 0) > 0.5;

  test("a grandchild takes effect only with every switch above it on", () => {
    const chain = switchChain(pond, "follow");
    expect(available(chain, on({ koi: 1, follow: 1 }))).toBe(true);
    expect(available(chain, on({ koi: 0, follow: 1 }))).toBe(false);
    expect(available(chain, on({ koi: 1, follow: 0 }))).toBe(false);
    expect(available([], on({}))).toBe(true);
  });
});

describe("whenProblems", () => {
  test("every scene's when names a switch of its own, without a loop", () => {
    for (const id of sceneIds) expect([id, whenProblems(sceneDefs[id].params)]).toEqual([id, []]);
  });

  test("a when naming nothing, a non-switch or a loop is reported", () => {
    const defs: ParamDef[] = [
      range("g", "size", "size", 0.5, "help"),
      range("g", "typo", "typo", 0.5, "help", { when: "sizee" }),
      range("g", "ranged", "ranged", 0.5, "help", { when: "size" }),
      toggle("g", "a", "a", true, "help", { when: "b" }),
      toggle("g", "b", "b", true, "help", { when: "a" }),
    ];
    const problems = whenProblems(defs);
    expect(problems.some((problem) => problem.startsWith("typo:"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("ranged:"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("a:"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("size:"))).toBe(false);
  });
});

describe("the lens and the search together", () => {
  const changed = new Set(["rain", "relief"]);
  const query = (text: string, lens: boolean): LensQuery => ({ text, lens, changed });
  const rain = { search: "rain how hard it rains", keys: ["rain", "rain-amount"], held: false };
  const snow = { search: "snow how hard it snows", keys: ["snow", "snow-amount"], held: false };
  const clock = { search: "clock freeze time", keys: [], held: false };

  test("nothing narrows: every control and group shows", () => {
    for (const item of [rain, snow, clock])
      expect(itemShows(item, false, query("", false))).toBe(true);
    expect(groupShows(0, false, query("", false))).toBe(true);
  });

  test("the search alone: a control's words or its group's title", () => {
    expect(itemShows(rain, false, query("rain", false))).toBe(true);
    expect(itemShows(snow, false, query("rain", false))).toBe(false);
    const titleHit = titleHolds("weather", query("weath", false));
    expect(itemShows(snow, titleHit, query("weath", false))).toBe(true);
    expect(groupShows(0, titleHit, query("weath", false))).toBe(true);
    expect(groupShows(0, false, query("weath", false))).toBe(false);
    expect(titleHolds("weather", query("", false))).toBe(false);
  });

  test("the lens alone: a control with a changed knob, or the one in hand", () => {
    expect(itemShows(rain, false, query("", true))).toBe(true);
    expect(itemShows(snow, false, query("", true))).toBe(false);
    expect(itemShows({ ...snow, held: true }, false, query("", true))).toBe(true);
    expect(itemShows(clock, false, query("", true))).toBe(false);
  });

  test("under the lens a group needs a control to show, its title alone is not enough", () => {
    const titleHit = titleHolds("weather", query("weather", true));
    expect(groupShows(0, titleHit, query("weather", true))).toBe(false);
    expect(groupShows(0, false, query("", true))).toBe(false);
    expect(groupShows(1, false, query("", true))).toBe(true);
  });

  test("both: a control must match the words and have changed", () => {
    expect(itemShows(rain, false, query("rain", true))).toBe(true);
    expect(itemShows(rain, false, query("snow", true))).toBe(false);
    expect(itemShows(snow, false, query("snow", true))).toBe(false);
    expect(itemShows({ ...snow, held: true }, false, query("rain", true))).toBe(false);
    expect(itemShows(snow, true, query("weather", true))).toBe(false);
    expect(itemShows(rain, true, query("weather", true))).toBe(true);
  });
});

/**
 * Pond's koi group as the Controls view lays it out: the koi's chip, the "drawn to mouse" chip (a
 * gate on the koi), and the personal space and eagerness rows (each a gate on "drawn to mouse").
 */
function koiGroup(params: Params): { items: NarrowItem[]; gates: LensGate[] } {
  const on = (key: string) => (params[key] ?? paramDefaults("pond")[key] ?? 0) > 0.5;
  const def = (key: string) => pond.find((each) => each.key === key);
  const gate = (key: string): LensGate => {
    const chain = switchChain(pond, def(key)?.when);
    return { chain, live: available(chain, on) };
  };
  const item = (key: string, gates: number[]): NarrowItem => {
    const knob = def(key);
    return {
      search: `${knob?.label ?? key} ${knob?.help ?? ""}`.toLowerCase(),
      keys: knob ? knobKeys(knob) : [],
      held: false,
      gates,
    };
  };
  return {
    items: [item("koi", []), item("follow", [0]), item("spacing", [1]), item("eager", [2])],
    gates: [gate("follow"), gate("spacing"), gate("eager")],
  };
}

describe("narrow", () => {
  const changed = (params: Params) => changedKnobs(pond, params, paramDefaults("pond"));
  const query = (params: Params, text: string, lens: boolean): LensQuery => ({
    text,
    lens,
    changed: changed(params),
  });

  test("a two-level when closes the grandchildren while the grandparent is off", () => {
    const params = { koi: 0, follow: 1 };
    const { items, gates } = koiGroup(params);
    expect(gates.map((gate) => gate.live)).toEqual([false, false, false]);
    expect(narrow(items, gates, false, query(params, "", false)).gates).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
    const on = { koi: 1, follow: 1 };
    const live = koiGroup(on);
    expect(narrow(live.items, live.gates, false, query(on, "", false)).gates).toEqual([
      "open",
      "open",
      "open",
    ]);
  });

  test("the lens counts a dormant change and shows it, with the switches it waits on", () => {
    // Personal space changed while "drawn to mouse" is off: counted, and on screen to see and reset.
    const params = { spacing: 0.9 };
    const groups = [{ id: "koi", knobs: pond.filter((def) => def.group === "koi").map(knobKeys) }];
    expect(changedCounts(groups, changed(params))).toEqual(new Map([["koi", 1]]));
    const { items, gates } = koiGroup(params);
    const narrowed = narrow(items, gates, false, query(params, "", true));
    // Personal space dormant, with the two switches it waits on found though unchanged ("drawn to
    // mouse" in its open gate, the koi's); eagerness, unchanged, stays closed.
    expect(narrowed.gates).toEqual(["open", "dormant", "closed"]);
    expect(narrowed.found).toEqual([true, true, true, false]);
    expect(narrowed.shown).toBe(3);
    expect(groupShows(narrowed.shown, false, query(params, "", true))).toBe(true);
  });

  test("a dormant change two levels down opens every gate up to the switch that is off", () => {
    const params = { koi: 0, follow: 1, spacing: 0.9 };
    const { items, gates } = koiGroup(params);
    const narrowed = narrow(items, gates, false, query(params, "", true));
    expect(narrowed.gates).toEqual(["dormant", "dormant", "closed"]);
    expect(narrowed.found).toEqual([true, true, true, false]);
  });

  test("a search whose only hit is folded shows it, dormant, never an empty group", () => {
    const params = { koi: 0, follow: 1 };
    const { items, gates } = koiGroup(params);
    const narrowed = narrow(items, gates, false, query(params, "eagerness", false));
    expect(narrowed.gates).toEqual(["dormant", "closed", "dormant"]);
    expect(narrowed.found).toEqual([true, true, false, true]);
    expect(narrowed.shown).toBe(3);
  });

  test("with the switches on, a hit opens as it is and pulls in nothing", () => {
    const params = { koi: 1, follow: 1 };
    const { items, gates } = koiGroup(params);
    const narrowed = narrow(items, gates, false, query(params, "eagerness", false));
    expect(narrowed.gates).toEqual(["open", "open", "open"]);
    expect(narrowed.found).toEqual([false, false, false, true]);
    expect(narrowed.shown).toBe(1);
  });

  test("a global setting gates the same way: transitions off, overlap changed", () => {
    const items: NarrowItem[] = [
      { search: "transitions", keys: ["transitions"], held: false, gates: [] },
      { search: "overlap", keys: ["overlap"], held: false, gates: [0] },
      { search: "blend length", keys: ["weave"], held: false, gates: [1] },
    ];
    const gates: LensGate[] = [
      { chain: ["transitions"], live: false },
      { chain: ["transitions"], live: false },
    ];
    const lens: LensQuery = { text: "", lens: true, changed: new Set(["overlap"]) };
    const narrowed = narrow(items, gates, false, lens);
    expect(narrowed.gates).toEqual(["dormant", "closed"]);
    expect(narrowed.found).toEqual([true, true, false]);
  });

  test("under a search, what changed and shows is all its reset takes", () => {
    // Motion and overlap changed; the search "blend" shows blend length (unchanged) alone.
    const items: NarrowItem[] = [
      { search: "amount motion", keys: ["motion"], held: false, gates: [] },
      { search: "transitions", keys: ["transitions"], held: false, gates: [] },
      { search: "overlap blend", keys: ["overlap"], held: false, gates: [0] },
      { search: "blend length", keys: ["weave"], held: false, gates: [1] },
    ];
    const gates: LensGate[] = [
      { chain: ["transitions"], live: false },
      { chain: ["transitions"], live: true },
    ];
    const changed = new Set(["motion", "overlap", "transitions"]);
    const search = (text: string) =>
      shownChanges(items, narrow(items, gates, false, { text, lens: true, changed }), changed);
    // Overlap shows dormant with the switch it waits on, which changed too; motion stays hidden.
    expect(search("overlap")).toEqual(["transitions", "overlap"]);
    expect(search("amount")).toEqual(["motion"]);
    expect(search("length")).toEqual([]);
    // The lens alone shows every change.
    expect(search("")).toEqual(["motion", "transitions", "overlap"]);
  });
});
