import { expect, test } from "bun:test";
import { HeadlessGl } from "../../sims/headless.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SceneSim, SimFrame } from "../types.ts";
import { lanternsScene } from "./index.ts";
import { EYE, FOCAL, HORIZON, LANTERN_HALF, MAX_LANTERNS, ROCKS } from "./sim.ts";

interface Seen {
  x: number;
  z: number;
  size: number;
  age: number;
}

function river(knobs: Record<string, number> = {}): { sim: SceneSim; frame: SimFrame; headless: HeadlessGl } {
  const headless = new HeadlessGl();
  const sim = lanternsScene.sim?.(headless.gl);
  if (!sim) throw new Error("lanterns has no sim");
  const params = { ...paramDefaults("lanterns"), ...knobs };
  const frame: SimFrame = {
    dt: 1 / 60,
    time: 0,
    motionTime: 0,
    motion: 1,
    width: 960,
    height: 540,
    aspect: 16 / 9,
    params,
    values: renderSettings(defaultsFor("lanterns"), params).params,
    triggers: new Array<number>(8).fill(-1e4),
    fired: new Array<boolean>(8).fill(false),
    pointer: { x: 0.4, y: 0.3, inside: true, down: false, pressed: false, released: false },
    passage: { enter: 1, exit: 0 },
  };
  return { sim, frame, headless };
}

/** One frame; each live lantern slot's x, z (m), size and age (s), as the shader receives them. */
function step(sim: SceneSim, frame: SimFrame, headless: HeadlessGl): Map<number, Seen> {
  frame.time += frame.dt;
  frame.motionTime += frame.dt * frame.motion;
  const data = headless.upload(sim.frame(frame)[0]).data;
  const lanterns = new Map<number, Seen>();
  for (let i = 0; i < MAX_LANTERNS; i++) {
    const z = data[i * 4 + 1] ?? 0;
    if (z === 0) continue;
    lanterns.set(i, { x: data[i * 4] ?? 0, z, size: data[(i + MAX_LANTERNS) * 4 + 3] ?? 1, age: data[(i + MAX_LANTERNS) * 4 + 2] ?? 0 });
  }
  return lanterns;
}

test("two lanterns set down on one spot while the river is still part once it runs again", () => {
  const { sim, frame, headless } = river();
  step(sim, frame, headless);
  // Paused (motion 0): two clicks at the same place put two lanterns on exactly the same spot.
  frame.motion = 0;
  const set: number[] = [];
  for (let click = 0; click < 2; click++) {
    frame.pointer.pressed = true;
    frame.pointer.down = true;
    for (const [slot, lantern] of step(sim, frame, headless)) if (lantern.age === 0 && !set.includes(slot)) set.push(slot);
    frame.pointer.pressed = false;
    frame.pointer.down = false;
    step(sim, frame, headless);
  }
  expect(set.length).toBe(2);
  frame.pointer.inside = false;
  frame.motion = 1;
  let lanterns = step(sim, frame, headless);
  for (let f = 0; f < 90; f++) lanterns = step(sim, frame, headless);
  const [a, b] = set.map((slot) => lanterns.get(slot));
  if (!a || !b) throw new Error("a set-down lantern left the river");
  // Their walls no longer pass through each other: centres at least a side apart.
  expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(LANTERN_HALF * (a.size + b.size) * 0.98);
});

test("lanterns set down on a stone, one onto another, end up on its face and never sink into it", () => {
  for (const rock of ROCKS) {
    const { sim, frame, headless } = river();
    // Click on the stone itself, again and again: each new lantern lands on the last ones.
    frame.pointer.x = 0.5 + (rock.x * FOCAL) / (frame.aspect * rock.z);
    frame.pointer.y = HORIZON - (EYE * FOCAL) / rock.z;
    let deepest = Number.NEGATIVE_INFINITY;
    let atFace = 0;
    for (let f = 0; f < 600; f++) {
      frame.pointer.pressed = f < 300 && f % 15 === 5;
      frame.pointer.down = frame.pointer.pressed;
      for (const lantern of step(sim, frame, headless).values()) {
        // Past its first steps on the water: the lantern's walls (half a side out) against the face.
        if (lantern.age < 0.04) continue;
        const gap = Math.hypot(lantern.x - rock.x, lantern.z - rock.z) - rock.radius - LANTERN_HALF * lantern.size;
        deepest = Math.max(deepest, -gap);
        if (gap < 0.1) atFace++;
      }
    }
    expect(atFace).toBeGreaterThan(0);
    expect(deepest).toBeLessThanOrEqual(0);
  }
});
