// The gardening chore (gardening.ts) on the apiary's beds (beds.ts), run headless through the bees'
// composed sim: an agent's visits dig and sow a bed, its flowers open and the bees go to them; the
// weeds come back and the lawn takes the bed back; the cast's agents garden the same every run; and
// without agents the chore hands over nothing new.
import { describe, expect, test } from "bun:test";
import { moveShape, signedDistance } from "../../composer/claims.ts";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { allocate } from "../../composer/sim.ts";
import { effective } from "../../params.ts";
import { CAST_MARGIN, Cast, PRESS_SECONDS, Presence, principal } from "../../principals.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import type { ScenePoint } from "../types.ts";
import { BED_OPEN, BED_PLANTS, BED_WEED_SECONDS, GardenBeds } from "./beds.ts";
import { PERCH_FRONT } from "./garden.ts";
import { beesComposed } from "./index.ts";
import {
  BEES_BED_DEPTH,
  BEES_BED_ROWS,
  BEES_BED_SPACING,
  BEES_CAM,
  BEES_CODE,
  BEES_YH,
  beesStage,
} from "./layout.ts";

const beesScene = await loadScene("bees");
const ASPECT = 16 / 9;
const DEFAULTS = Object.fromEntries(
  beesComposed.def.params.map((def) => [def.key, effective(def, {})]),
);
const PLACED = beesComposed.placed(DEFAULTS);
/** The gardening layer's row of the records atlas at the bees' defaults. */
const ROW = allocate(PLACED.layers.map((placed) => placed.layer)).rows["gardening"]?.base ?? -1;
const BEE_CODES: readonly number[] = [
  BEES_CODE.bee,
  BEES_CODE.beeDim,
  BEES_CODE.beeFaint,
  BEES_CODE.beeWing,
  BEES_CODE.beeLoaded,
];

/** The beds as the gardening layer's records hand them to the shader, in a GardenBeds to ask. */
function bedsOf(sim: HeadlessSim): GardenBeds {
  const data = sim.upload(1).data;
  const beds = new GardenBeds();
  beds.rows.forEach((row, k) => {
    const at = (ROW * ATLAS_WIDTH + 1 + 2 * k) * 4;
    row.dug = data[at] ?? Number.NaN;
    row.sown = data[at + 1] ?? Number.NaN;
    row.age = data[at + 2] ?? Number.NaN;
    row.weeds = data[at + 3] ?? Number.NaN;
    row.lost = data[at + 4] ?? Number.NaN;
  });
  return beds;
}

/** Which bed an interest point is the middle of. */
function bedAt(point: ScenePoint | undefined): number {
  const k = BEES_BED_ROWS.findIndex((row) => row.y === point?.y);
  if (k < 0) throw new Error(`no bed at ${JSON.stringify(point)}`);
  return k;
}

/** An agent's visit to `at` as the cast pays one: a press held PRESS_SECONDS, then still for `stay` s. */
function visit(sim: HeadlessSim, at: ScenePoint, stay = 3): void {
  const held = Math.round(PRESS_SECONDS * 60);
  for (let n = 0; n < held + stay * 60; n++)
    sim.step({ agents: [{ x: at.x, y: at.y, down: n < held, pressed: n === 0 }] });
}

/** An agent about and idle, high in the sky: there are beds only while an agent is about. */
const IDLE = { x: 0.5, y: 0.85, down: false };

/** `seconds` with the agent idle. */
function run(sim: HeadlessSim, seconds: number): void {
  for (let n = 0; n < seconds * 60; n++) sim.step({ agents: [IDLE] });
}

/**
 * Bee specks within two cells of bed k's flower heads (garden.ts: a perch just in front of each), its
 * plants open in `beds`: the foragers at work there, few of them only passing.
 */
function beesOnHeads(sim: HeadlessSim, beds: GardenBeds, k: number): number {
  const row = BEES_BED_ROWS[k];
  const plants = BED_PLANTS[k];
  if (row === undefined || plants === undefined) return 0;
  const { width, height, data } = sim.upload(0);
  const z = BEES_CAM / (BEES_YH - row.y);
  const near = (z - PERCH_FRONT) / z;
  let n = 0;
  plants.forEach((plant, i) => {
    if (beds.growth(k, i) < BED_OPEN) return;
    const x = (row.f * beesStage(ASPECT) * z + plant.x) * near;
    const h = BEES_CAM - (BEES_CAM - plant.tall) * near;
    const cx = Math.floor((x / (z - PERCH_FRONT) / ASPECT + 0.5) * width);
    const cy = Math.floor((BEES_YH - (BEES_CAM - h) / (z - PERCH_FRONT)) * height);
    for (let y = cy - 2; y <= cy + 2; y++)
      for (let c = cx - 2; c <= cx + 2; c++)
        if (BEE_CODES.includes(data[2 * (y * width + c)] ?? 0)) n++;
  });
  return n;
}

describe("the beds", () => {
  test("stand clear of the path, the lavender, the hives and the wall, their middles in the frame, at any width", () => {
    const blockers = PLACED.claims.filter((claim) => claim.kind === "exclusive");
    for (const aspect of [1.24, 1.6, 16 / 9, 2.4]) {
      const stage = beesStage(aspect);
      const stretch = stage / beesStage(1.24);
      for (const row of BEES_BED_ROWS) {
        const z = BEES_CAM / (BEES_YH - row.y);
        const half = 0.5 * row.plants * BEES_BED_SPACING;
        for (const dz of [-BEES_BED_DEPTH, 0, BEES_BED_DEPTH])
          for (let along = -1; along <= 1; along += 0.25) {
            const zz = z + dz;
            const x = row.f * stage * z + along * half;
            const y = BEES_YH - BEES_CAM / zz;
            const sx = x / zz;
            // shader.ts beesPathEdge, at its widest.
            const ease = Math.min(1, y / 0.38);
            const wind = Math.min(1, Math.max(0, (y - 0.02) / 0.18));
            const path =
              stage *
              (0.05 +
                0.3 * ease * ease * (3 - 2 * ease) +
                0.05 * Math.sin(y * 8 + 1) * wind * wind * (3 - 2 * wind));
            const at = `bed at ${row.f}, ${row.y} (${along}, ${dz}), aspect ${aspect}`;
            expect(Math.abs(sx - path) > (0.6 * 1.025) / zz || y > 0.4, `${at}: on the path`).toBe(
              true,
            );
            // beesLavender's lanes and their bushes, out to 9.2 m.
            expect(zz > 9.2 || x > -1.9 || x < -6.7, `${at}: in the lavender`).toBe(true);
            for (const claim of blockers) {
              const shape =
                claim.layer === "apiary" ? moveShape(claim.shape, [0, 0], stretch) : claim.shape;
              expect(signedDistance(shape, [x, zz]) > 0, `${at}: in ${claim.name}`).toBe(true);
            }
            if (along === 0)
              expect(Math.abs(sx) < (0.5 - CAST_MARGIN) * aspect, `${at}: out of the frame`).toBe(
                true,
              );
          }
      }
    }
  });

  test("an agent digs a bed and sows it, its flowers open within two minutes, the bees go to them, and they go with the last agent", () => {
    const sim = new HeadlessSim(beesScene);
    const bare = new HeadlessSim(beesScene);
    sim.step({});
    bare.step({});
    // The bed of poppies out on the open lawn, where hardly any bee passes on its way elsewhere.
    const k = 0;
    const row = BEES_BED_ROWS[k];
    if (row === undefined) throw new Error("no bed 0");
    const site = { x: 0.5 + (row.f * beesStage(ASPECT)) / ASPECT, y: row.y };
    const plants = BED_PLANTS[k]?.length ?? 0;
    visit(sim, site);
    expect(bedsOf(sim).rows[k]).toMatchObject({ dug: 1, sown: 0 });
    visit(sim, site);
    const sown = bedsOf(sim);
    expect(sown.rows[k]?.sown).toBe(1);
    expect(sown.open(k)).toBe(0);
    run(sim, 50);
    // Seedlings up the whole row, none open yet.
    const growing = bedsOf(sim);
    expect(Array.from({ length: plants }, (_, i) => growing.growth(k, i) > 0.4)).not.toContain(
      false,
    );
    expect(growing.open(k)).toBeLessThan(plants);
    run(sim, 60);
    expect(bedsOf(sim).open(k)).toBe(plants);
    run(bare, 6 + 110);
    // The bees go to its open flowers, more of them as more foragers find the bed.
    const open = bedsOf(sim);
    let on = 0;
    let by = 0;
    for (let n = 0; n < 150 * 60; n++) {
      sim.step({ agents: [IDLE] });
      bare.step({ agents: [IDLE] });
      if (n % 30 === 0) {
        on += beesOnHeads(sim, open, k);
        by += beesOnHeads(bare, open, k);
      }
    }
    expect(on).toBeGreaterThan(Math.max(30, 3 * by));
    // The last agent goes, and the bed goes back to the lawn with it.
    sim.step({});
    expect(bedsOf(sim).rows[k]).toEqual({ dug: 0, sown: 0, age: 0, weeds: 0, lost: 0 });
    sim.dispose();
    bare.dispose();
  }, 60_000);

  test("weeds come back and choke a bed left alone till the lawn has it back; weeding keeps it", () => {
    const plant = (): { sim: HeadlessSim; k: number; site: ScenePoint } => {
      const sim = new HeadlessSim(beesScene);
      sim.step({ knobs: { bees: 0 } });
      const [site] = sim.interest(ASPECT);
      if (site === undefined) throw new Error("the chore declares no bed");
      visit(sim, site);
      visit(sim, site);
      return { sim, k: bedAt(site), site };
    };
    const left = plant();
    const tended = plant();
    const plants = BED_PLANTS[left.k]?.length ?? 0;
    run(left.sim, 110);
    run(tended.sim, 110);
    expect(bedsOf(left.sim).open(left.k)).toBe(plants);
    // Weedy by now: the planted bed is where the agents are sent.
    expect(tended.sim.interest(ASPECT)).toContainEqual(tended.site);
    visit(tended.sim, tended.site);
    expect(bedsOf(tended.sim).rows[tended.k]?.weeds).toBeLessThan(0.02);
    // Half-way, the weeds have choked some of the bed left alone.
    run(left.sim, 0.55 * BED_WEED_SECONDS - 116);
    const choked = bedsOf(left.sim);
    expect(choked.rows[left.k]?.weeds).toBeGreaterThan(0.5);
    expect(choked.open(left.k)).toBeGreaterThan(0);
    expect(choked.open(left.k)).toBeLessThan(plants);
    // Covered: the lawn has it back.
    run(left.sim, 0.5 * BED_WEED_SECONDS);
    expect(bedsOf(left.sim).rows[left.k]).toEqual({ dug: 0, sown: 0, age: 0, weeds: 0, lost: 0 });
    run(tended.sim, 0.55 * BED_WEED_SECONDS - 116);
    expect(bedsOf(tended.sim).open(tended.k)).toBe(plants);
    left.sim.dispose();
    tended.sim.dispose();
  }, 60_000);

  test("the cast's agents garden the same every run, more of them sent to more beds", () => {
    const garden = (agents: number) => {
      const sim = new HeadlessSim(beesScene);
      const cast = new Cast(DEFAULTS["seed"] ?? 0);
      const presence = new Presence();
      const visitor = principal({ inside: true });
      const wanted: number[] = [];
      for (let n = 0; n < 90 * 60; n++) {
        const poses = cast.poses(sim.motionTime, ASPECT, agents, sim);
        presence.update(visitor, -1e4, poses, 1 / 60, sim.time);
        sim.step({ agents: presence.principals.slice(1) });
        if (n === 0) wanted.push(sim.interest(ASPECT).length);
      }
      const beds = bedsOf(sim);
      const out = {
        wanted,
        dug: beds.rows.filter((row) => row.dug > 0).length,
        records: Array.from(sim.upload(1).data),
        specks: Array.from(sim.upload(0).data),
      };
      sim.dispose();
      return out;
    };
    const two = garden(2);
    expect(two.dug).toBeGreaterThanOrEqual(3);
    expect(garden(2)).toEqual(two);
    const one = garden(1);
    const three = garden(3);
    expect([one.wanted, two.wanted, three.wanted]).toEqual([[1], [2], [3]]);
    expect(one.dug).toBeGreaterThanOrEqual(2);
    expect(three.dug).toBeGreaterThan(one.dug);
  }, 120_000);

  test("without agents the chore hands over nothing new", () => {
    const on = new HeadlessSim(beesScene);
    const off = new HeadlessSim(beesScene);
    const empty = new Float32Array(ATLAS_WIDTH * 4);
    for (let n = 0; n < 60 * 60; n++) {
      on.step({});
      off.step({ knobs: { gardening: 0 } });
      if (n % 60 !== 0) continue;
      expect(Array.from(on.upload(0).data)).toEqual(Array.from(off.upload(0).data));
      const records = on.upload(1).data;
      expect(records.slice(ROW * ATLAS_WIDTH * 4, (ROW + 1) * ATLAS_WIDTH * 4)).toEqual(empty);
    }
    on.dispose();
    off.dispose();
  }, 60_000);
});
