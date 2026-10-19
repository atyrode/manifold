import { expect, test } from "bun:test";
import { readTour, TOUR_DWELL, TOUR_FRAME_CAP, TourPlayer, writeTour, type Tour } from "./tour.ts";

const tour = (query: string): Tour => {
  const read = readTour(new URLSearchParams(query));
  if (!read) throw new Error(`no tour in ${query}`);
  return read;
};

test("a tour link reads back exactly as the lab writes it", () => {
  const read = tour("tour=physarum-60.petri.delta&dwell=40");
  expect(read).toEqual({
    steps: [{ scene: "physarum", dwell: 60 }, { scene: "petri" }, { scene: "delta" }],
    dwell: 40,
  });
  const written = new URLSearchParams();
  writeTour(read, written);
  expect(written.toString()).toBe("tour=physarum-60.petri.delta&dwell=40");
  // The fallback dwell is left out of the link.
  const plain = new URLSearchParams();
  writeTour({ steps: [{ scene: "pond" }], dwell: TOUR_DWELL.fallback }, plain);
  expect(plain.toString()).toBe("tour=pond");
});

test("unknown, lab-only and repeated scenes are dropped and dwells kept within bounds", () => {
  expect(tour("tour=pond.nowhere.room.pond.Forest.lake-x.forest-1.orbit-99999&dwell=abc")).toEqual({
    steps: [
      { scene: "pond" },
      { scene: "forest", dwell: TOUR_DWELL.min },
      { scene: "orbit", dwell: TOUR_DWELL.max },
    ],
    dwell: TOUR_DWELL.fallback,
  });
  expect(tour("tour=pond&dwell=3").dwell).toBe(TOUR_DWELL.min);
  expect(readTour(new URLSearchParams("tour=nowhere.."))).toBeUndefined();
  expect(readTour(new URLSearchParams("scene=pond"))).toBeUndefined();
});

test("dwell runs on the scene clock's capped pace, so slow frames still give a scene its time", () => {
  const player = new TourPlayer(tour("tour=pond-12.forest&dwell=20"), true);
  // One-second frames (a 1 fps machine) count TOUR_FRAME_CAP each, as the renderer's clock does.
  const frames = Math.round(12 / TOUR_FRAME_CAP);
  for (let i = 1; i < frames; i++) expect(player.tick(1, false)).toBeUndefined();
  expect(player.tick(1, false)).toBe("forest");
  expect(player.index).toBe(1);
  expect(player.elapsed).toBe(0);
  expect(player.dwell).toBe(20);
});

test("nothing passes while the clock is paused or the tour is held", () => {
  const player = new TourPlayer(tour("tour=pond.forest"), true);
  for (let i = 0; i < 1000; i++) expect(player.tick(0.05, true)).toBeUndefined();
  expect(player.elapsed).toBe(0);
  player.playing = false;
  for (let i = 0; i < 1000; i++) expect(player.tick(0.05, false)).toBeUndefined();
  expect(player.elapsed).toBe(0);
});

test("the tour wraps round, skips both ways, and a lone scene never moves on", () => {
  const player = new TourPlayer(tour("tour=pond-10.forest-10.lake-10"), true);
  const visited: string[] = [];
  for (let i = 0; i < 3 * (10 / 0.05) + 1; i++) {
    const next = player.tick(0.05, false);
    if (next) visited.push(next);
  }
  expect(visited).toEqual(["forest", "lake", "pond"]);
  expect(player.skip(-1)).toBe("lake");
  expect(player.skip(2)).toBe("forest");

  const lone = new TourPlayer(tour("tour=pond-10"), true);
  for (let i = 0; i < 1000; i++) expect(lone.tick(0.05, false)).toBeUndefined();
  expect(lone.elapsed).toBe(10);
});

test("the scene a tour moves on to, fetched ahead, is the next step's, wrapping round", () => {
  const player = new TourPlayer(tour("tour=pond.forest.lake"), true);
  const upcoming = [player.upcoming];
  for (let step = 0; step < 3; step++) {
    player.skip(1);
    upcoming.push(player.upcoming);
  }
  expect(upcoming).toEqual(["forest", "lake", "pond", "forest"]);
  expect(new TourPlayer(tour("tour=pond"), true).upcoming).toBe("pond");
});

test("the page's scene steers the tour: a step restarts there, any other scene holds it", () => {
  const player = new TourPlayer(tour("tour=pond.forest.lake"), true);
  player.tick(0.1, false);
  expect(player.follow("pond")).toBe(true);
  expect(player.elapsed).toBeCloseTo(0.1);
  expect(player.follow("lake")).toBe(true);
  expect(player.index).toBe(2);
  expect(player.elapsed).toBe(0);
  expect(player.playing).toBe(true);
  expect(player.follow("orbit")).toBe(false);
  expect(player.playing).toBe(false);
  expect(player.index).toBe(2);
});

test("editing the tour keeps its place on the current scene", () => {
  const player = new TourPlayer(tour("tour=pond.forest.lake"), true);
  player.skip(1);
  player.tick(0.1, false);
  player.edit(tour("tour=lake.forest.pond"));
  expect(player.step.scene).toBe("forest");
  expect(player.index).toBe(1);
  expect(player.elapsed).toBeCloseTo(0.1);
  // A dwell cut below what has already run ends the step on the next frame.
  for (let i = 0; i < 149; i++) expect(player.tick(0.1, false)).toBeUndefined();
  player.edit(tour("tour=lake.forest-10.pond"));
  expect(player.elapsed).toBe(10);
  expect(player.tick(0.1, false)).toBe("pond");
  // Removing the current scene stays at its place in the list and starts that step afresh.
  player.edit(tour("tour=lake.forest"));
  expect(player.index).toBe(1);
  expect(player.elapsed).toBe(0);
  expect(() => player.edit({ steps: [], dwell: 30 })).toThrow(RangeError);
});
