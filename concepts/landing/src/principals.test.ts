import { describe, expect, test } from "bun:test";
import {
  CAST_MARGIN,
  Cast,
  MAX_AGENTS,
  MAX_PRINCIPALS,
  PRESS_SECONDS,
  Presence,
  principal,
  type Pose,
} from "./principals.ts";
import { loadScene } from "./scenes/index.ts";
import type { ScenePoint } from "./scenes/types.ts";
import { common } from "./shaders/common.ts";
import { main } from "./shaders/main.ts";
import { shakeGlsl } from "./shaders/shake.ts";
import { HeadlessSim } from "./sims/headless.ts";

/** A sim's points of interest, as SceneSim.interest gives them. */
const scene = (points: readonly ScenePoint[]) => ({ interest: () => points });

/** The cast's poses every `dt` motion seconds over `seconds`, copied. */
function run(
  cast: Cast,
  seconds: number,
  dt: number,
  aspect: number,
  interest = scene([]),
): Pose[][] {
  const out: Pose[][] = [];
  for (let t = 0; t <= seconds; t += dt)
    out.push(cast.poses(t, aspect, MAX_AGENTS, interest).map((pose) => ({ ...pose })));
  return out;
}

describe("the scripted cast", () => {
  test("is a function of its seed and the motion clock alone", () => {
    const a = run(new Cast(7), 120, 0.25, 16 / 9);
    const b = run(new Cast(7), 120, 0.25, 16 / 9);
    expect(a).toEqual(b);
    // Asked out of order (a time earlier than the last replays from the start), the same poses.
    const cast = new Cast(7);
    cast.poses(119, 16 / 9, MAX_AGENTS, scene([]));
    expect(cast.poses(30, 16 / 9, MAX_AGENTS, scene([])).map((p) => ({ ...p }))).toEqual(
      a[120] ?? [],
    );
    // Another seed is another cast.
    expect(run(new Cast(8), 120, 0.25, 16 / 9)).not.toEqual(a);
  });

  test("stands still while the motion clock does", () => {
    const cast = new Cast(3);
    const first = cast.poses(42, 16 / 9, MAX_AGENTS, scene([])).map((p) => ({ ...p }));
    expect(cast.poses(42, 16 / 9, MAX_AGENTS, scene([])).map((p) => ({ ...p }))).toEqual(first);
  });

  test("an agent's path does not change as others join or leave", () => {
    const alone = new Cast(5);
    const crowd = new Cast(5);
    for (let t = 0; t < 90; t += 0.5) {
      const one = alone.poses(t, 16 / 9, 1, scene([]))[0];
      const all = crowd.poses(t, 16 / 9, MAX_AGENTS, scene([]))[0];
      expect(one).toEqual(all);
    }
  });

  test("stays inside the frame, whatever the aspect and wherever the points of interest lie", () => {
    const corners = scene([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 2 },
    ]);
    for (const aspect of [16 / 9, 9 / 16, 1, 21 / 9]) {
      for (const poses of run(new Cast(11), 600, 1 / 30, aspect, corners)) {
        for (const pose of poses) {
          expect(pose.x).toBeGreaterThanOrEqual(CAST_MARGIN - 1e-9);
          expect(pose.x).toBeLessThanOrEqual(1 - CAST_MARGIN + 1e-9);
          expect(pose.y).toBeGreaterThanOrEqual(CAST_MARGIN - 1e-9);
          expect(pose.y).toBeLessThanOrEqual(1 - CAST_MARGIN + 1e-9);
        }
      }
    }
  });

  test("goes to the scene's points of interest, pauses and presses briefly there", () => {
    const points = [
      { x: 0.3, y: 0.4 },
      { x: 0.7, y: 0.6 },
    ];
    const frames = run(new Cast(2), 300, 1 / 60, 16 / 9, scene(points));
    let presses = 0;
    let held = 0;
    for (let f = 1; f < frames.length; f++) {
      for (let i = 0; i < MAX_AGENTS; i++) {
        const now = frames[f]?.[i];
        const was = frames[f - 1]?.[i];
        if (now === undefined || was === undefined || !now.down) continue;
        held++;
        // Pressing, it stands still on a point of interest.
        expect(now).toMatchObject({ x: was.x, y: was.y });
        expect(points.some((p) => Math.hypot(p.x - now.x, p.y - now.y) < 1e-9)).toBe(true);
        if (!was.down) presses++;
      }
    }
    expect(presses).toBeGreaterThan(10);
    // Briefly: about PRESS_SECONDS a press.
    expect(held / presses / 60).toBeCloseTo(PRESS_SECONDS, 1);
  });
});

describe("a frame's principals", () => {
  test("the visitor first, then the agents, with press edges, velocities and press times", () => {
    const presence = new Presence();
    const visitor = principal({ inside: true, x: 0.2, y: 0.3 });
    presence.update(visitor, -1e4, [{ x: 0.5, y: 0.5, down: false, inside: true }], 1 / 60, 10);
    expect(presence.principals.map((p) => p.kind)).toEqual(["human", "agent"]);
    expect(presence.principals[0]).toBe(visitor);
    // Newly come: no velocity yet.
    expect(presence.principals[1]).toMatchObject({ vx: 0, vy: 0, pressed: false, inside: true });
    presence.update(visitor, -1e4, [{ x: 0.51, y: 0.5, down: true, inside: true }], 0.5, 10.5);
    expect(presence.principals[1]?.vx).toBeCloseTo(0.02, 9);
    expect(presence.principals[1]).toMatchObject({ down: true, pressed: true, released: false });
    expect(Array.from(presence.upload.slice(4, 8))).toEqual([
      Math.fround(0.51),
      Math.fround(0.5),
      1,
      Math.fround(10.5),
    ]);
    presence.update(visitor, -1e4, [{ x: 0.51, y: 0.5, down: false, inside: true }], 0.5, 11);
    expect(presence.principals[1]).toMatchObject({ down: false, pressed: false, released: true });
    // The agents leave: the visitor alone.
    presence.update(visitor, -1e4, [], 0.5, 11.5);
    expect(presence.principals).toEqual([visitor]);
  });

  test("an agent away from the page is no hand on it, and stands off it", () => {
    const presence = new Presence();
    const visitor = principal({ inside: false, x: 0.2, y: 0.3 });
    presence.update(visitor, -1e4, [{ x: 0.5, y: 0.5, down: true, inside: true }], 1 / 60, 10);
    presence.update(visitor, -1e4, [{ x: 0.6, y: 0.5, down: false, inside: false }], 0.5, 10.5);
    expect(presence.principals[1]).toMatchObject({ x: 0.6, y: 0.5, inside: false, down: false });
    expect(Array.from(presence.upload.slice(4, 8))).toEqual([-1, -1, 0, Math.fround(10)]);
    expect(Array.from(presence.motion.slice(2, 4))).toEqual([0, 0]);
    // The visitor off the page keeps its last point; the agent back on it stands where it is.
    expect(Array.from(presence.upload.slice(0, 2))).toEqual([Math.fround(0.2), Math.fround(0.3)]);
    presence.update(visitor, -1e4, [{ x: 0.62, y: 0.5, down: false, inside: true }], 0.5, 11);
    expect(presence.principals[1]?.inside).toBe(true);
    expect(Array.from(presence.upload.slice(4, 6))).toEqual([Math.fround(0.62), Math.fround(0.5)]);
  });

  test("a sim reacts to every principal: an agent's hand stirs the shore as the visitor's does", async () => {
    // The sea's wake: the shore's first field, its third sim slot (composer/sim.ts).
    const WAKE = 2;
    const shore = await loadScene("shore");
    const sim = new HeadlessSim(shore);
    for (let f = 0; f < 30; f++)
      sim.step({ pointer: { inside: false }, agents: [{ x: 0.25 + 0.01 * f, y: 0.4 }] });
    const { width, height, data } = sim.upload(WAKE);
    const at = (x: number, y: number): number =>
      data[Math.floor(y * height) * width + Math.floor(x * width)] ?? 0;
    // The agent's wake, and nothing where the visitor (off the page) or nobody went.
    expect(at(0.4, 0.4)).toBeGreaterThan(0);
    expect(at(0.75, 0.75)).toBe(0);
    // The visitor alone, away: no wake at all, its field handed over all the same.
    const still = new HeadlessSim(shore);
    expect(still.frame({ pointer: { inside: false } })[WAKE]).toBeDefined();
    sim.dispose();
    still.dispose();
  });
});

describe("the principals' uniforms", () => {
  /** Vectors a program's uniforms take (a row an element of up to four components; samplers none). */
  function rows(source: string, only?: RegExp): number {
    const sizes: Readonly<Record<string, number>> = {
      MAX_PRINCIPALS,
      "MAX_PRINCIPALS / 2": MAX_PRINCIPALS / 2,
    };
    let total = 0;
    const declared = /^uniform\s+(\w+)\s+(\w+)(?:\[([^\]]+)\])?;/gm;
    for (const [, type, name, size] of source.matchAll(declared)) {
      if (type === undefined || name === undefined || type.startsWith("sampler")) continue;
      if (only !== undefined && !only.test(name)) continue;
      total += size === undefined ? 1 : (sizes[size] ?? Number(size));
    }
    return total;
  }
  const probe = (reads: string): string =>
    `Shade probe(vec2 uv, vec2 cell, float t) {\n  Shade o = blankShade();\n  o.ink = ${reads};\n  return o;\n}\n`;

  test("take the eight vectors allotted to them, and only where something reads them", () => {
    const principals = /^uPrincipal/;
    // The cursors' overlay reads every one of them, behind its gate.
    const gated = shakeGlsl(
      `${common}#define PRINCIPAL_CURSORS 1\n${probe("0.0")}${main("probe")}`,
    );
    expect(rows(gated, principals)).toBe(MAX_PRINCIPALS + 1 + MAX_PRINCIPALS / 2);
    expect(rows(gated, principals)).toBeLessThanOrEqual(8);
    // Without the gate a scene that reads no principal pays nothing for them.
    expect(rows(shakeGlsl(`${common}${probe("0.0")}${main("probe")}`), principals)).toBe(0);
    // A scene reading the visitor alone pays the array, not the overlay's motion.
    const visitor = shakeGlsl(`${common}${probe("uPrincipals[0].z")}${main("probe")}`);
    expect(rows(visitor, principals)).toBe(MAX_PRINCIPALS);
  });
});
