import { expect, test } from "bun:test";
import {
  HOLD_MS,
  readComparison,
  setupDifferences,
  TapOrHold,
  writeComparison,
} from "./compare.ts";
import { defaultsFor, readParams, readState, serialise } from "./state.ts";
import { readTour, writeTour } from "./tour.ts";

/** The page's URL as main.ts writes it: the setup, then the lab's session keys. */
function pageQuery(setup: string, session: (query: URLSearchParams) => void): URLSearchParams {
  const query = new URLSearchParams(setup);
  session(query);
  return new URLSearchParams(query.toString());
}

test("a compare link keeps the hidden slot apart from the setup on screen", () => {
  const query = pageQuery("scene=forest&rain=1&motion=0.3", (q) =>
    writeComparison({ live: "b", other: "scene=forest&color=mono&rain=0&dim=0.4" }, q),
  );
  expect(query.toString()).toBe(
    "scene=forest&rain=1&motion=0.3&compare=b&a.scene=forest&a.color=mono&a.rain=0&a.dim=0.4",
  );
  // The page reads its own setup: the a.-prefixed keys never leak into it.
  const state = readState(query);
  const params = readParams(state.scene, query);
  expect(serialise(state, params, []).toString()).toBe("scene=forest&motion=0.3&rain=1");
  expect(state.color).not.toBe("mono");
  expect(state.dim).toBe(0);
  // The hidden slot reads back as a minimal setup of its own.
  expect(readComparison(query)).toEqual({ live: "b", other: "scene=forest&color=mono&dim=0.4" });
});

test("the hidden slot is normalised like any setup, and defaults need no keys", () => {
  const read = readComparison(
    new URLSearchParams(
      "scene=orbit&compare=a&b.scene=pond&b.motion=7&b.nonsense=1&b.dither=sparkle",
    ),
  );
  expect(read).toEqual({ live: "a", other: "motion=1" });
  const both = new URLSearchParams();
  writeComparison({ live: "a", other: "" }, both);
  expect(both.toString()).toBe("compare=a");
  expect(readComparison(both)).toEqual({ live: "a", other: "" });
  expect(readComparison(new URLSearchParams("compare=c&c.scene=pond"))).toBeUndefined();
  expect(readComparison(new URLSearchParams("scene=pond"))).toBeUndefined();
});

test("the hidden slot keeps its planets, normalised, and they count as one difference", () => {
  const read = readComparison(new URLSearchParams("compare=a&b.scene=frost&b.planets=AQEA"));
  expect(read).toEqual({ live: "a", other: "scene=frost&planets=AQEA" });
  // A malformed list is none: the slot reads as its scene alone.
  expect(readComparison(new URLSearchParams("compare=a&b.scene=frost&b.planets=%%"))).toEqual({
    live: "a",
    other: "scene=frost",
  });
  expect(setupDifferences("scene=frost&planets=AQEA", "scene=frost")).toEqual(["planets"]);
});

test("a page with a comparison and a tour reads back its setup and both session tools", () => {
  const tour = {
    steps: [{ scene: "orbit" as const, dwell: 45 }, { scene: "swell" as const }],
    dwell: 20,
  };
  // A levels value that is never swell's own default, so it is kept in the slot's query.
  const levels = defaultsFor("swell").levels === 2 ? 3 : 2;
  const other = `scene=swell&levels=${levels}`;
  const query = pageQuery("scene=orbit&pixel=3", (q) => {
    writeComparison({ live: "a", other }, q);
    writeTour(tour, q);
  });
  const state = readState(query);
  expect(serialise(state, readParams(state.scene, query), []).toString()).toBe(
    "scene=orbit&pixel=3",
  );
  expect(readComparison(query)).toEqual({ live: "a", other });
  expect(readTour(query)).toEqual(tour);
});

test("differences name the scene first, then every key either setup changes", () => {
  expect(setupDifferences("scene=forest&rain=1&pixel=3", "pixel=3&color=mono")).toEqual([
    "scene",
    "rain",
    "color",
  ]);
  expect(setupDifferences("scene=forest&rain=1", "scene=forest&rain=1")).toEqual([]);
  expect(setupDifferences("rain=1", "rain=0.5")).toEqual(["rain"]);
});

test("a tap flips and stays, a hold flips back on release", () => {
  const flip = new TapOrHold();
  flip.press(1000);
  expect(flip.release(1000 + HOLD_MS - 1)).toBe(false);
  flip.press(2000);
  expect(flip.release(2000 + HOLD_MS)).toBe(true);
  // A release with no press (the key went down in a text field) is never a hold.
  expect(flip.release(9000)).toBe(false);
  // A press whose release was missed (focus left the window) is timed afresh by the next press.
  flip.press(10_000);
  flip.press(20_000);
  expect(flip.release(20_000 + HOLD_MS - 1)).toBe(false);
});
