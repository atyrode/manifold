import { describe, expect, test } from "bun:test";
import {
  constellationUniforms,
  JOIN_FIRST,
  JOIN_REST,
  JOIN_WINDOW,
  joinNight,
  joinPlan,
  joinTime,
  skyJoinAway,
} from "./constellations.ts";
import { effective } from "./params.ts";
import type { Pose } from "./principals.ts";
import { sceneDefs, type SceneId } from "./scenes/index.ts";
import { skyFigures } from "./shaders/lib/sky.ts";
import { paramDefaults } from "./state.ts";
import { DAY_SECONDS, SUNSET } from "./world-clock.ts";

/** A scene's knobs as the shader reads them, at its defaults with `over` (keyed as in the URL). */
function values(scene: SceneId, over: Record<string, number>): number[] {
  const knobs = { ...paramDefaults(scene), ...over };
  return sceneDefs[scene].params.map((def) => effective(def, knobs));
}

/** Which of `agents` agents skyJoinAway takes off the page at `motionTime`: a 0 or 1 for each. */
function away(
  scene: SceneId,
  knobs: readonly number[],
  agents: number,
  motionTime: number,
  phases: Record<string, number> = {},
): string {
  const poses: Pose[] = Array.from({ length: agents }, () => ({
    x: 0.5,
    y: 0.5,
    down: true,
    inside: true,
  }));
  skyJoinAway(poses, sceneDefs[scene].params, knobs, phases, motionTime);
  for (const pose of poses) if (!pose.inside) expect(pose.down).toBe(false);
  return poses.map((pose) => (pose.inside ? "0" : "1")).join("");
}

const ON = { constellations: 1 };
/** Every half second of the first `seconds` of the motion clock. */
const halves = (seconds: number): number[] =>
  Array.from({ length: seconds * 2 + 1 }, (_, i) => i / 2);
/** One agent's runs up in the sky among `flags` (away's, one a sample), in samples. */
const runs = (flags: readonly string[], agent: number): string[] =>
  flags
    .map((flag) => flag[agent])
    .join("")
    .match(/1+/g) ?? [];

describe("the star-joining plan", () => {
  test("joins every figure line once, from star to star, one after another", () => {
    const { lines, markLine } = constellationUniforms;
    expect(joinPlan.figures.map((figure) => figure.lines)).toEqual(
      skyFigures.map((figure) => figure.lines),
    );
    expect(joinPlan.lines.length).toBe(markLine);
    joinPlan.lines.forEach((line, i) => {
      const ends = [lines[i * 2] ?? -1, lines[i * 2 + 1] ?? -1];
      expect([line.from, line.to]).toEqual(line.from === ends[0] ? ends : ends.reverse());
    });
    for (const figure of joinPlan.figures) {
      const [first, end] = figure.lines;
      const opening = joinPlan.lines[first];
      expect(opening).toMatchObject({ leave: 0, arrive: 0 });
      for (let i = first; i < end; i++) {
        const line = joinPlan.lines[i];
        const before = joinPlan.lines[i - 1];
        if (line === undefined || before === undefined) continue;
        expect(line.leave).toBeLessThanOrEqual(line.arrive);
        expect(line.arrive).toBeLessThanOrEqual(line.start);
        expect(line.start).toBeLessThan(line.end);
        if (i === first) continue;
        expect(line.leave).toBeGreaterThan(before.end);
        // It hops only where the line does not start at the star the cursor is on.
        expect(line.arrive === line.leave).toBe(line.from === before.to);
      }
      expect(figure.seconds).toBeGreaterThan(joinPlan.lines[end - 1]?.end ?? Infinity);
    }
  });
});

describe("the agents up in the sky", () => {
  test("are a function of the knobs and the clocks alone", () => {
    const knobs = values("frost", { ...ON, time: 0 });
    const times = halves(240);
    const forward = times.map((t) => away("frost", knobs, 3, t));
    const backward = [...times].reverse().map((t) => away("frost", knobs, 3, t));
    expect(backward.reverse()).toEqual(forward);
    expect(forward.some((flags) => flags.includes("1"))).toBe(true);
  });

  test("one agent joins every figure at midnight, back on the page between them, then stays", () => {
    const knobs = values("frost", { ...ON, time: 0 });
    const times = halves(400);
    const flags = times.map((t) => away("frost", knobs, 1, t));
    expect(flags.slice(0, JOIN_FIRST * 2).every((flag) => flag === "0")).toBe(true);
    expect(flags[JOIN_FIRST * 2]).toBe("1");
    // Six figures, one after another, each its job's length away and JOIN_REST back (to a sample).
    const jobs = runs(flags, 0);
    expect(jobs.length).toBe(joinPlan.figures.length);
    const total = joinPlan.figures.reduce((sum, figure) => sum + figure.seconds, 0);
    expect(Math.abs(jobs.join("").length / 2 - total)).toBeLessThanOrEqual(jobs.length / 2);
    const gaps =
      flags
        .join("")
        .replace(/^0+|0+$/g, "")
        .match(/0+/g) ?? [];
    expect(gaps.length).toBe(jobs.length - 1);
    for (const gap of gaps) expect(Math.abs(gap.length / 2 - JOIN_REST)).toBeLessThanOrEqual(0.5);
    // Done: every figure joined, nothing left for the night.
    const last = JOIN_FIRST + total + JOIN_REST * (joinPlan.figures.length - 1);
    expect(flags.slice(Math.ceil(last * 2) + 1).every((flag) => flag === "0")).toBe(true);
    const night = joinNight(0, 0, 400, 1, 6);
    for (const [figure, { seconds }] of joinPlan.figures.entries())
      expect(joinTime(night, figure)).toBeGreaterThan(seconds);
  });

  test("share the night's figures, each agent its own", () => {
    const knobs = values("frost", { ...ON, time: 0 });
    const flags = halves(200).map((t) => away("frost", knobs, 3, t));
    // All three up together at some point.
    expect(flags).toContain("111");
    // Two figures each.
    for (let agent = 0; agent < 3; agent++)
      expect({ agent, jobs: runs(flags, agent).length }).toEqual({ agent, jobs: 2 });
    // Fewer figures a night: the knob's amount, the first agents' alone.
    const two = values("frost", { ...ON, time: 0, "join-amount": 2 });
    const few = halves(200).map((t) => away("frost", two, 3, t));
    expect([0, 1, 2].map((agent) => runs(few, agent).length)).toEqual([1, 1, 0]);
  });

  test("stay on the page by day, without the knob, the figures or the stars, and with none", () => {
    const quiet = (over: Record<string, number>, scene: SceneId = "frost") => {
      const knobs = values(scene, over);
      return halves(120).every((t) => away(scene, knobs, 3, t) === "000");
    };
    expect(quiet({ ...ON, time: 0.5 })).toBe(true);
    expect(quiet({ time: 0 })).toBe(true);
    expect(quiet({ ...ON, time: 0, join: 0 })).toBe(true);
    expect(quiet({ ...ON, time: 0, stars: 0 })).toBe(true);
    // Before the stars are a third out, and once they begin to fade.
    expect(quiet({ ...ON, time: SUNSET + JOIN_WINDOW[0] - 0.01 })).toBe(true);
    expect(quiet({ ...ON, time: SUNSET + JOIN_WINDOW[1] - 1 + 0.01 })).toBe(true);
    // No agents: nothing to mark.
    expect(away("frost", values("frost", { ...ON, time: 0 }), 0, 10)).toBe("");
  });

  test("work from the scene's start in a night of the scene's own", () => {
    const knobs = values("lake", ON);
    expect(away("lake", knobs, 1, JOIN_FIRST - 0.5)).toBe("0");
    expect(away("lake", knobs, 1, JOIN_FIRST + 0.5)).toBe("1");
  });
});

describe("tonight's work", () => {
  test("counts from the window's opening as the days pass, and never from before the scene", () => {
    const [from, to] = JOIN_WINDOW;
    // The day cycle at full pace, the scene long begun: the work is the time since it opened.
    const dusk = SUNSET + from;
    let night = joinNight(dusk + 0.01, 1, 1e4, 2, 6);
    expect(night.open).toBe(true);
    expect(night.work).toBeCloseTo(0.01 * DAY_SECONDS, 6);
    // Half as fast a cycle: twice as long since then.
    expect(joinNight(dusk + 0.01, 0.5, 1e4, 2, 6).work).toBeCloseTo(0.02 * DAY_SECONDS, 6);
    // A scene just begun counts from its start.
    expect(joinNight(dusk + 0.01, 1, 0.5, 2, 6).work).toBe(0.5);
    // Not yet, and no more: before the window and after it, its night's work as it ended.
    night = joinNight(dusk - 0.005, 1, 1e4, 2, 6);
    expect([night.open, night.work < 0]).toEqual([false, true]);
    night = joinNight(SUNSET + to + 0.1, 1, 1e4, 2, 6);
    expect(night.open).toBe(false);
    expect(night.work).toBeCloseTo((to - from) * DAY_SECONDS, 6);
    // Each night starts one figure further on.
    const firsts = [0, 1, 2, 3, 7].map((days) => joinNight(dusk + 0.01 + days, 1, 1e4, 2, 6).first);
    expect(firsts).toEqual([0, 1, 2, 3, 1]);
  });

  test("with the cycle running, the agents are up only at night, and again the next", () => {
    const knobs = values("frost", { ...ON, time: 0.75, cycle: 1, "cycle-amount": 1 });
    // A day at pace 1 takes DAY_SECONDS; begun at sunset, the scene's days are its motion clock's.
    const up = (t: number) => away("frost", knobs, 1, t, { cycle: t / DAY_SECONDS }) === "1";
    const seconds = (days: number) => days * DAY_SECONDS;
    const [from, to] = JOIN_WINDOW;
    const first = seconds(from) + JOIN_FIRST;
    expect(up(first - 0.5)).toBe(false);
    expect(up(first + 0.5)).toBe(true);
    // Day: on the page.
    for (const day of [0.6, 0.75, 0.9]) expect(up(seconds(day))).toBe(false);
    // The next night it starts afresh.
    expect(up(seconds(1 + to) + 1)).toBe(false);
    expect(up(seconds(1 + from) + JOIN_FIRST - 0.5)).toBe(false);
    expect(up(seconds(1 + from) + JOIN_FIRST + 0.5)).toBe(true);
  });
});
