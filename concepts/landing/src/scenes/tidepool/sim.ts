// The tide pool's sea, on the GPU: shallow water (sims/shallow.ts) over the rock of layout.ts. A wave
// maker in the band along the top edge raises a swell of two trains a little apart in length and
// heading, so the waves come in groups; every so often a set of bigger ones (or one at once, "now").
// The waves shoal, steepen and break over the reefs, run up the rock and drain back; the bigger ones
// pour through the notch in the basin's rim and over it, and the basin keeps what they bring until
// it has spilled back down to its sill. The tide raises and lowers the whole sea, from a basin cut
// off from the waves to one they wash right across.
//
// The water also carries, for the shader:
//   foam       white water made where the flow outruns its own waves (bores, the surge over the rim,
//              swash), carried along and fading, slower on standing water
//   agitation  what the anemones feel: a hard surge or a touch closes them; they reopen over seconds
//   wetness    rock the water has run over, drying again over half a minute
// The pointer dips a finger: a tap drops a ring of ripples and startles the anemones around it,
// a drag trails ripples behind it.
//
// The life in the pool (life.ts) answers the water from the CPU: each frame the flow is averaged
// onto a coarse grid on the GPU and read back without stalling (sims/readback.ts), a frame or two
// late, and the plants stream and the fish dart in it.
//
// Textures:
//   uSim0  ShallowWater.surface: depth (cells), level slope xy, caustic focus (rgba16f linear)
//   uSim1  foam, agitation, wetness, 0 (rgba16f linear)
//   uSim2  the layout: bed (cells), still depth, inside the basin, in the surge channel (rgba16f linear)
//   uSim3  the life: fish, the coarse flow and the plants' records (life.ts; rgba16f nearest)
// Without float render targets the layout's still water is shown, unmoving, its plants and fish
// still alive in it.
//
// Heights are in cells, exaggerated TIDEPOOL_RELIEF times against the frame (layout.ts); the grid is
// TIDEPOOL_ROWS rows over the frame's height at every aspect, so the physics is the same on a phone.
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { GpuCompute, type RenderTarget } from "../../sims/gpu.ts";
import { hash31, lerp } from "../../sims/math.ts";
import { PLANT_SUMMER } from "../../sims/plants.ts";
import { GpuReadback } from "../../sims/readback.ts";
import { ShallowWater } from "../../sims/shallow.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import {
  layTidepool,
  TIDEPOOL_HEIGHTS,
  TIDEPOOL_RELIEF,
  TIDEPOOL_SEA_BAND,
  type TidepoolLayout,
} from "./layout.ts";
import { TIDEPOOL_LIFE_WIDTH, TidepoolLife } from "./life.ts";

/** Grid rows over the frame's height (columns follow the aspect). */
export const TIDEPOOL_ROWS = 200;
/** Gravity (cells/s²): waves over the 8-cell-deep sea floor run at 0.22 frame heights a second. */
const GRAVITY = 242;
const FRICTION = 0.04;
/** Momentum viscosity (ShallowOptions.viscosity): stills the grid's chequerboard ripples. */
const VISCOSITY = 0.12;
/** Sim step (seconds) and the most a frame takes. */
const STEP = 1 / 120;
const MAX_STEPS = 12;
/** Warm-up: steps a fresh layout runs before it is shown, at most this many ms a frame, in chunks. */
const PREWARM_STEPS = 720;
const PREWARM_MS = 40;
const PREWARM_CHUNK = 24;
/** Wall-clock ms the layout's knobs and the frame's shape must rest before the rock is laid anew. */
const RELAYOUT_MS = 300;
/** The tide's swing either way (cells) and its period at the day-cycle knob's slow and quick ends (s). */
const TIDE_RANGE = 1.6;
const TIDE_PERIOD = [600, 90] as const;
/** Swell: wavelength (frame heights) at the period knob's ends; amplitude (cells) at swell 1. */
const WAVELENGTH = [0.5, 1.2] as const;
const SWELL = 1.6;
/** The second train: its length and amplitude against the first's, and its turn (radians). */
const SECOND = { length: 0.83, amplitude: 0.45, turn: 0.12 } as const;
/** How far the swell's heading turns at the direction knob's ends (radians). */
const HEADING = 0.6;
/** Sets: seconds between them at the knob's rare and frequent ends, how long one lasts, how much bigger at its peak. */
const SET_EVERY = [80, 20] as const;
const SET_LENGTH = 14;
const SET_GAIN = 1.3;
/** The wave maker's relaxation rate at the top edge (1/s), fading to 0 at its band's inner edge. */
const MAKER_RATE = 30;
/** A tap: ripple radius and height (cells), and how far round it the anemones startle. */
const TAP = { radius: 3, height: 1.6, reach: 12 } as const;
/** A drag: a ripple every so many cells along the path. */
const DRAG = { radius: 2.2, height: 0.5, spacing: 2.5 } as const;

export const TIDEPOOL_SIM_KNOBS = [
  "tide",
  "tideCycle",
  "swell",
  "period",
  "heading",
  "sets",
  "pace",
  "foam",
  "poolSize",
  "rock",
  "response",
  "fish",
  "season",
  "growth",
] as const;
type Knob = (typeof TIDEPOOL_SIM_KNOBS)[number];

/** The water's flow, averaged onto the life's coarse grid: velocity (cells/s) and depth. */
const FLOW_PROBE = `
uniform sampler2D uWater;
void main() {
  vec4 sum = vec4(0.0);
  for (int k = 0; k < 4; k++) sum += texture(uWater, vUv + (vec2(float(k % 2), float(k / 2)) - 0.5) * 0.5 * uTexel);
  fragColor = vec4(sum.y, sum.z, sum.x, 0.0) * 0.25;
}
`;

/** The life's knobs for this frame, into `out` (the plant knobs' season: high summer while off). */
function readLifeKnobs(
  knobs: KnobReader<Knob>,
  frame: SimFrame,
  out: { response: number; fish: number; season: number; growth: number },
): void {
  out.response = knobs.value(frame, "response");
  out.fish = knobs.value(frame, "fish");
  out.season = knobs.on(frame, "season") ? knobs.amount(frame, "season") : PLANT_SUMMER;
  out.growth = knobs.value(frame, "growth");
}

const FORCING = `
uniform float uSea;        // the sea's level (cells)
uniform vec4 uSwellA;      // first train: heading xy (unit), wavenumber (rad/cell), phase (rad)
uniform vec4 uSwellB;      // second train
uniform vec2 uSwellAmp;    // their amplitudes (cells)
uniform float uBand;       // rows below the top edge the wave maker reaches
uniform float uRate;       // its relaxation rate at the edge (1/s)

// The swell as it runs in: each train's level and the flow under it (c · η / h along its heading,
// a shallow-water wave), so the waves leave the band one way and those coming back are soaked up.
vec4 shallowForcing(vec2 uv, float bed) {
  float fromTop = uSize.y - gl_FragCoord.y;
  if (fromTop > uBand) return vec4(0.0);
  vec2 p = gl_FragCoord.xy;
  float a = uSwellAmp.x * cos(uSwellA.z * dot(uSwellA.xy, p) - uSwellA.w);
  float b = uSwellAmp.y * cos(uSwellB.z * dot(uSwellB.xy, p) - uSwellB.w);
  vec2 flow = sqrt(uGravity / max(uSea - bed, 0.5)) * (a * uSwellA.xy + b * uSwellB.xy);
  return vec4(uSea + a + b, flow, uRate * (1.0 - smoothstep(0.0, uBand, fromTop)));
}
`;

const CARRY = `
uniform vec4 uPoke;   // a touch: cell xy, reach (cells), strength 0..1
uniform float uFoam;  // the foam knob

vec4 shallowCarry(vec2 uv, vec4 carried, vec4 here, vec4 water) {
  float depth = water.x;
  float speed = length(water.yz);
  // White water where the flow outruns its own waves, the more the faster: bores, the surge over the
  // rim, swash. It rides the flow and fades, slowly on standing water, at once on bare rock.
  float froude = speed / sqrt(uGravity * max(depth, 0.02));
  float source = smoothstep(0.8, 1.6, froude) * smoothstep(0.03, 0.2, depth) * smoothstep(4.0, 14.0, speed);
  float foam = min(carried.x * exp(-uDt * (depth > 0.05 ? 0.3 : 4.0)) + uDt * 5.0 * source * uFoam, 1.5);
  // Anemones close in a hard surge or at a touch, and reopen over some ten seconds.
  vec2 d = gl_FragCoord.xy - uPoke.xy;
  float touch = uPoke.w * exp(-dot(d, d) / max(uPoke.z * uPoke.z, 1.0));
  float agitation = max(here.y * exp(-uDt / 9.0), max(smoothstep(12.0, 30.0, speed), touch));
  // Rock the water runs over is wet, and dries over half a minute.
  float wet = depth > 0.03 ? 1.0 : here.z * exp(-uDt / 25.0);
  return vec4(foam, agitation, wet, 0.0);
}
`;

/** The grid the frame wants, and the layout knobs it was asked with. */
interface LayoutKey {
  columns: number;
  rows: number;
  seed: number;
  size: number;
}

function sameKey(a: LayoutKey, b: LayoutKey): boolean {
  return a.columns === b.columns && a.rows === b.rows && a.seed === b.seed && a.size === b.size;
}

/** How far into a set of bigger waves the swell is at sim second `time`: 0 between sets, up to 1. */
export function tidepoolSet(time: number, every: number, seed: number): number {
  const slot = Math.floor(time / every);
  let level = 0;
  for (let k = slot - 1; k <= slot; k++) {
    const start = (k + 0.1 + 0.6 * hash31(k, seed, 41)) * every;
    const age = (time - start) / SET_LENGTH;
    if (age > 0 && age < 1)
      level = Math.max(level, Math.sin(Math.PI * age) ** 2 * (0.6 + 0.4 * hash31(k, seed, 43)));
  }
  return level;
}

/** The sea and its swell for sim second `time`, written into the forcing's uniforms. */
class Swell {
  readonly uniforms = {
    uSea: 0,
    uSwellA: new Float32Array(4),
    uSwellB: new Float32Array(4),
    uSwellAmp: new Float32Array(2),
    uBand: Math.round(TIDEPOOL_SEA_BAND * TIDEPOOL_ROWS),
    uRate: MAKER_RATE,
  };

  /** Fill the uniforms: sea level and swell height in cells, wavelength in cells, heading in radians. */
  write(time: number, sea: number, height: number, wavelength: number, heading: number): void {
    const u = this.uniforms;
    u.uSea = sea;
    // Waves over the band's floor run at sqrt(g · depth); each train's phase is kept in double
    // precision and handed over wrapped, so the GPU's float never loses it over a long visit.
    const speed = Math.sqrt(GRAVITY * Math.max(sea - TIDEPOOL_HEIGHTS.seaFloor, 1));
    const trains = [
      [u.uSwellA, wavelength, heading],
      [u.uSwellB, wavelength * SECOND.length, heading + SECOND.turn],
    ] as const;
    for (const [train, length, turn] of trains) {
      const k = (2 * Math.PI) / length;
      train[0] = Math.sin(turn);
      train[1] = -Math.cos(turn);
      train[2] = k;
      train[3] = (speed * k * time) % (2 * Math.PI);
    }
    u.uSwellAmp[0] = height;
    u.uSwellAmp[1] = height * SECOND.amplitude;
  }
}

/** Data textures for machines without float render targets: the layout's still water, unmoving, and its life. */
function stillSim(gl: WebGL2RenderingContext, knobs: KnobReader<Knob>): SceneSim {
  let key: LayoutKey | undefined;
  const textures: (WebGLTexture | undefined)[] = [];
  const made: DataTexture[] = [];
  const life = new TidepoolLife(gl);
  const lifeFrame = { response: 0, fish: 0, season: PLANT_SUMMER, growth: 0 };
  return {
    frame(frame) {
      const want: LayoutKey = {
        columns: Math.max(32, Math.round(TIDEPOOL_ROWS * frame.aspect)),
        rows: TIDEPOOL_ROWS,
        seed: knobs.value(frame, "rock"),
        size: knobs.value(frame, "poolSize"),
      };
      if (key === undefined || !sameKey(key, want)) {
        key = want;
        const layout = layTidepool(
          want.columns,
          want.rows,
          want.seed,
          want.size,
          knobs.value(frame, "tide") * TIDE_RANGE,
        );
        const n = want.columns * want.rows;
        const surface = new Float32Array(n * 4);
        const carried = new Float32Array(n * 4);
        for (let k = 0; k < n; k++) {
          const depth = layout.rest[k] ?? 0;
          surface[k * 4] = depth;
          surface[k * 4 + 3] = 1;
          carried[k * 4 + 2] = depth > 0 ? 1 : 0;
        }
        for (const texture of made) texture.dispose();
        made.length = 0;
        for (const data of [surface, carried, layout.texture]) {
          const texture = new DataTexture(gl, {
            width: want.columns,
            height: want.rows,
            format: "rgba16f",
          });
          texture.upload(data);
          made.push(texture);
        }
        life.relay(layout, want.seed);
      }
      readLifeKnobs(knobs, frame, lifeFrame);
      life.step(frame.dt * frame.motion, frame.motionTime, lifeFrame, frame.pointer);
      textures.length = 0;
      for (const texture of made) textures.push(texture.texture);
      textures.push(life.texture);
      return textures;
    },
    dispose() {
      for (const texture of made) texture.dispose();
      life.dispose();
    },
  };
}

/** The tide pool's water, for a scene whose `params` carry the knobs TIDEPOOL_SIM_KNOBS names. */
export function tidepoolSim(params: readonly ParamDef[]): SimFactory {
  return (gl: WebGL2RenderingContext): SceneSim => {
    const knobs = new KnobReader<Knob>("tidepool", params, TIDEPOOL_SIM_KNOBS);
    const gpu = GpuCompute.create(gl);
    if (!gpu) return stillSim(gl, knobs);
    const setSlot = knobs.trigger("sets");
    const clock = new FixedStep(STEP, MAX_STEPS);
    const swell = new Swell();
    const carry = { uPoke: new Float32Array(4), uFoam: 0 };
    const textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined, undefined];
    const step = { dt: STEP, time: 0, uniforms: swell.uniforms };
    const life = new TidepoolLife(gl);
    const lifeFrame = { response: 0, fish: 0, season: PLANT_SUMMER, growth: 0 };
    const probe = gpu.pass(FLOW_PROBE, "tidepool flow probe");
    let flow: RenderTarget | undefined;
    let readback: GpuReadback | undefined;

    let water: ShallowWater | undefined;
    let layoutTexture: DataTexture | undefined;
    let key: LayoutKey | undefined;
    let pending: LayoutKey | undefined;
    let pendingSince = 0;
    let warmed = PREWARM_STEPS;
    /** Sim seconds since the layout (the wave maker's clock); "now" set's start. */
    let time = 0;
    let setStart = -Infinity;
    let lastX = 0;
    let lastY = 0;
    let dragging = false;

    /** The sea level, swell height, wavelength and heading for this frame's knobs at sim second `at`. */
    const writeSwell = (frame: SimFrame, at: number): void => {
      const cycle = knobs.value(frame, "tideCycle");
      const period = lerp(TIDE_PERIOD[0], TIDE_PERIOD[1], cycle);
      const sea =
        TIDE_RANGE *
        (cycle > 0
          ? Math.max(
              -1,
              Math.min(1, knobs.value(frame, "tide") + Math.sin((2 * Math.PI * at) / period)),
            )
          : knobs.value(frame, "tide"));
      const sets = knobs.value(frame, "sets");
      // The sets that come by themselves, and the one "now" started.
      const age = (at - setStart) / SET_LENGTH;
      const set = Math.max(
        sets > 0 ? tidepoolSet(at, lerp(SET_EVERY[0], SET_EVERY[1], sets), key?.seed ?? 0) : 0,
        age > 0 && age < 1 ? Math.sin(Math.PI * age) ** 2 : 0,
      );
      const height = SWELL * knobs.value(frame, "swell") * (1 + SET_GAIN * set);
      const wavelength =
        lerp(WAVELENGTH[0], WAVELENGTH[1], knobs.value(frame, "period")) * TIDEPOOL_ROWS;
      swell.write(at, sea, height, wavelength, HEADING * knobs.value(frame, "heading"));
    };

    /** Lay the rock out afresh for `want` and still its water; the frame then runs the warm-up. */
    const relayout = (frame: SimFrame, want: LayoutKey): ShallowWater => {
      const sea = TIDE_RANGE * knobs.value(frame, "tide");
      const layout: TidepoolLayout = layTidepool(
        want.columns,
        want.rows,
        want.seed,
        want.size,
        sea,
      );
      if (water === undefined || water.width !== want.columns || water.height !== want.rows) {
        water?.dispose();
        water = new ShallowWater(gpu, {
          width: want.columns,
          height: want.rows,
          gravity: GRAVITY,
          friction: FRICTION,
          viscosity: VISCOSITY,
          // The heights are exaggerated against the frame: light bends as through water that deep.
          refraction: 0.25 * TIDEPOOL_RELIEF * TIDEPOOL_RELIEF,
          forcing: FORCING,
          carry: CARRY,
        });
        layoutTexture?.dispose();
        layoutTexture = new DataTexture(gl, {
          width: want.columns,
          height: want.rows,
          format: "rgba16f",
        });
      }
      water.setBed(layout.bed);
      water.reset(layout.rest);
      layoutTexture?.upload(layout.texture);
      key = { ...want };
      life.relay(layout, want.seed);
      // The coarse flow the life reads back, on its grid.
      if (flow === undefined || flow.height !== life.flowRows) {
        flow?.dispose();
        readback?.dispose();
        flow = gpu.target({
          width: TIDEPOOL_LIFE_WIDTH,
          height: life.flowRows,
          format: "rgba32f",
          filter: "nearest",
        });
        readback = new GpuReadback(gl, TIDEPOOL_LIFE_WIDTH, life.flowRows);
      }
      warmed = 0;
      time = 0;
      setStart = -Infinity;
      clock.reset();
      return water;
    };

    /** The textures, once the life has stepped `seconds` (its fish and plants) in the latest flow read back. */
    const show = (
      sim: ShallowWater,
      frame: SimFrame,
      seconds: number,
    ): readonly (WebGLTexture | undefined)[] => {
      if (flow && readback) {
        probe.run(flow, { textures: { uWater: sim.water } });
        readback.poll(life.flow);
        readback.request(flow.framebuffer);
      }
      readLifeKnobs(knobs, frame, lifeFrame);
      life.step(seconds, frame.motionTime, lifeFrame, frame.pointer);
      textures[0] = sim.surface.texture;
      textures[1] = sim.carried?.texture;
      textures[2] = layoutTexture?.texture;
      textures[3] = life.texture;
      return textures;
    };

    return {
      frame(frame) {
        const now = frame.now;
        const want: LayoutKey = {
          columns: Math.max(32, Math.round(TIDEPOOL_ROWS * frame.aspect)),
          rows: TIDEPOOL_ROWS,
          seed: knobs.value(frame, "rock"),
          size: knobs.value(frame, "poolSize"),
        };
        if (pending === undefined || !sameKey(pending, want)) {
          pending = want;
          pendingSince = now;
        }
        let sim = water;
        if (sim === undefined || key === undefined) sim = relayout(frame, want);
        else if (!sameKey(key, want) && now - pendingSince >= RELAYOUT_MS)
          sim = relayout(frame, want);
        carry.uFoam = knobs.value(frame, "foam");

        // The warm-up: a fixed count of steps from sim second 0, over as many frames as it takes. The
        // carried field follows once a chunk, and the GPU is synced there so the budget measures its
        // work rather than how fast commands queue up.
        if (warmed < PREWARM_STEPS) {
          const warming = sim;
          warmed = runBudgeted(
            (i) => {
              writeSwell(frame, (i + 1) * STEP);
              step.time = (i + 1) * STEP;
              warming.step(step);
              if ((i + 1) % PREWARM_CHUNK === 0) {
                warming.carry(PREWARM_CHUNK * STEP, step.time, carry);
                gl.finish();
              }
            },
            PREWARM_MS,
            PREWARM_STEPS,
            warmed,
            PREWARM_CHUNK,
          );
          if (warmed < PREWARM_STEPS) {
            sim.view();
            return show(sim, frame, 0);
          }
          time = PREWARM_STEPS * STEP;
        }

        if (frame.fired[setSlot] === true) setStart = time;

        // The finger: a tap rings the water and startles the anemones round it; a drag trails ripples.
        const pointer = frame.pointer;
        const poke = carry.uPoke;
        poke[3] = 0;
        if (pointer.inside && pointer.down) {
          const x = pointer.x * sim.width;
          const y = pointer.y * sim.height;
          if (pointer.pressed || !dragging) {
            sim.splat(x, y, TAP.radius, TAP.height);
            lastX = x;
            lastY = y;
          } else {
            const gap = Math.hypot(x - lastX, y - lastY);
            for (let s = DRAG.spacing; s <= gap; s += DRAG.spacing)
              sim.splat(lerp(lastX, x, s / gap), lerp(lastY, y, s / gap), DRAG.radius, DRAG.height);
            if (gap >= DRAG.spacing) {
              lastX = x;
              lastY = y;
            }
          }
          poke[0] = x;
          poke[1] = y;
          poke[2] = TAP.reach;
          poke[3] = 1;
          dragging = true;
        } else {
          dragging = false;
        }

        const seconds = Math.max(0, frame.dt) * frame.motion * knobs.value(frame, "pace");
        const steps = clock.advance(seconds);
        for (let i = 0; i < steps; i++) {
          time += STEP;
          writeSwell(frame, time);
          step.time = time;
          sim.step(step);
        }
        if (seconds > 0) sim.carry(seconds, time, carry);
        sim.view();
        return show(sim, frame, Math.max(0, frame.dt) * frame.motion);
      },
      dispose() {
        water?.dispose();
        layoutTexture?.dispose();
        readback?.dispose();
        life.dispose();
        gpu.dispose();
      },
    };
  };
}
