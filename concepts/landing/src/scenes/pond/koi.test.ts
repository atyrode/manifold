import { describe, expect, test } from "bun:test";
import { effective } from "../../params.ts";
import { visitorAlone } from "../../principals.ts";
import type { SimFrame } from "../types.ts";
import { pondScene } from "./index.ts";
import { koiLoop, koiLoops, PondKoi } from "./koi.ts";

const DT = 1 / 60;
const ASPECT = 16 / 9;
const loops = koiLoops();

interface Pointer {
  x: number;
  y: number;
  inside: boolean;
}

/** A pond whose knobs are the defaults plus `knobs`, run frame by frame at `motion`. */
function pond(knobs: Record<string, number>, motion = 1) {
  const raw: Record<string, number> = { ...knobs };
  const koi = new PondKoi(pondScene.params);
  let time = 0;
  let motionTime = 0;
  const frame = (pointer: Pointer): WebGLTexture | undefined => {
    time += DT;
    motionTime += DT * motion;
    const values = pondScene.params.map((def) => effective(def, raw));
    const simFrame: SimFrame = {
      dt: DT,
      time,
      motionTime,
      motion,
      now: time * 1000,
      budget: Infinity,
      width: 960,
      height: 540,
      aspect: ASPECT,
      values,
      params: raw,
      triggers: [],
      fired: [],
      ...visitorAlone(pointer),
      passage: { enter: 1, exit: 0 },
    };
    return koi.frame(simFrame);
  };
  return { koi, raw, frame, motionTime: () => motionTime };
}

/** The pointer hovering in small circles about (0.7, 0.6) in uv at scene time t. */
const hover = (t: number): Pointer => ({
  x: 0.7 + 0.04 * Math.cos(t * 1.3),
  y: 0.6 + 0.04 * Math.sin(t * 1.3),
  inside: true,
});
const away: Pointer = { x: 0.5, y: 0.5, inside: false };

/** Smallest centre distance between two of the first `count` koi, in their mean body length. */
function closestPair(koi: PondKoi, count: number): number {
  const g = koi.group;
  let closest = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const d = Math.hypot((g.x[i] ?? 0) - (g.x[j] ?? 0), (g.y[i] ?? 0) - (g.y[j] ?? 0));
      closest = Math.min(closest, d / (0.5 * ((loops[i]?.len ?? 0) + (loops[j]?.len ?? 0))));
    }
  }
  return closest;
}

/** The farthest any koi is from its place on the shader's loop. */
function offLoop(koi: PondKoi, motionTime: number, swim: number): number {
  const at = new Float64Array(4);
  let far = 0;
  loops.forEach((loop, i) => {
    koiLoop(loop, motionTime * (0.6 + 2.4 * swim) + i * 11, ASPECT, at);
    far = Math.max(
      far,
      Math.hypot((koi.group.x[i] ?? 0) - (at[0] ?? 0), (koi.group.y[i] ?? 0) - (at[1] ?? 0)),
    );
  });
  return far;
}

describe("pond koi drawn to the pointer", () => {
  test("off, the sim never takes the koi from the shader's loops", () => {
    const run = pond({ follow: 0, "koi-amount": 8 });
    for (let k = 0; k < 600; k++) {
      expect(run.frame(hover(k * DT))).toBeUndefined();
      expect(run.koi.shown).toBe(0);
    }
  });

  test("on from the first frame, every koi starts on its loop, fully steered", () => {
    const run = pond({ follow: 1 });
    run.frame(away);
    expect(run.koi.shown).toBe(1);
    expect(offLoop(run.koi, run.motionTime(), 0.4)).toBeLessThan(1e-3);
  });

  test("they come to a moving pointer and mill about it without piling up", () => {
    const crowding = (spacing: number): { near: number; piled: number } => {
      const run = pond({ follow: 1, "koi-amount": 8, spacing, eager: 1 });
      let piled = 0;
      let frames = 0;
      for (let k = 0; k < 14 * 60; k++) {
        run.frame(hover(k * DT));
        if (k > 6 * 60) {
          frames++;
          if (closestPair(run.koi, 8) < 0.5) piled++;
        }
      }
      const lx = (hover(14).x - 0.5) * ASPECT;
      const ly = hover(14).y - 0.5;
      let near = 0;
      for (let i = 0; i < 8; i++)
        if (Math.hypot((run.koi.group.x[i] ?? 0) - lx, (run.koi.group.y[i] ?? 0) - ly) < 0.3)
          near++;
      return { near, piled: piled / frames };
    };
    const spaced = crowding(0.5);
    const piling = crowding(0);
    expect(spaced.near).toBeGreaterThanOrEqual(6);
    expect(spaced.piled).toBeLessThan(0.1);
    // With no personal space they do pile onto the same spot: the separation is what prevents it.
    expect(piling.piled).toBeGreaterThan(0.5);
  });

  test("a resting pointer loses them: they swim back to their own loops", () => {
    const run = pond({ follow: 1, "koi-amount": 5 });
    for (let k = 0; k < 8 * 60; k++) run.frame(hover(k * DT));
    expect(Math.max(...[0, 1, 2, 3, 4].map((i) => run.koi.interest(i)))).toBeGreaterThan(0.5);
    const rest = hover(8);
    for (let k = 0; k < 40 * 60; k++) run.frame(rest);
    for (let i = 0; i < 8; i++) expect(run.koi.interest(i)).toBe(0);
    expect(offLoop(run.koi, run.motionTime(), 0.4)).toBeLessThan(0.05);
  });

  test("turned off, they swim home and the shader takes them back", () => {
    const run = pond({ follow: 1, "koi-amount": 8 });
    for (let k = 0; k < 8 * 60; k++) run.frame(hover(k * DT));
    run.raw.follow = 0;
    let frames = 0;
    while (run.frame(away) !== undefined || run.koi.shown > 0) {
      frames++;
      expect(frames).toBeLessThan(10 * 60);
    }
    expect(run.koi.shown).toBe(0);
    expect(offLoop(run.koi, run.motionTime(), 0.4)).toBeLessThan(0.05);
  });

  test("motion 0 stills them, and the hand-over still completes", () => {
    const run = pond({ follow: 1 }, 0);
    run.frame(away);
    const x = [...run.koi.group.x];
    const y = [...run.koi.group.y];
    for (let k = 0; k < 300; k++) run.frame(hover(k * DT));
    expect([...run.koi.group.x]).toEqual(x);
    expect([...run.koi.group.y]).toEqual(y);
    run.raw.follow = 0;
    for (let k = 0; k < 8 * 60; k++) run.frame(away);
    expect(run.koi.shown).toBe(0);
  });
});
