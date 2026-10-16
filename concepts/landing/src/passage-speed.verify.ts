// Passages carry their speed (src/scenes/README.md, "Entrances and exits"): how fast each scene's
// picture changes across its exit and its entrance, on the real renderer and a hand-driven clock at
// motion 0, so the scene's own motion stands still while the passage (which plays in real time
// whatever the motion, its sim stepping on) runs. A side below FLOOR fails unless exempt.
import { DitherRenderer } from "./renderer.ts";
import { sceneDefs } from "./scenes/index.ts";
import type { SceneId } from "./scenes/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./state.ts";

const STEPS = 20;
const WIDTH = 160;
const HEIGHT = 100;
/** Least share of its fastest step a passage keeps over the last exit / first entrance steps. */
const FLOOR = 0.35;

/** Sides of a passage this measure does not apply to, and why. */
const EXEMPT: Partial<Record<SceneId, { exit?: string; enter?: string }>> = {
  bonsai: {
    exit: "the stand leaves the frame at full speed",
    enter: "the stand comes in from beyond the frame at full speed",
  },
  campfire: { enter: "a fire catching from embers in the dark" },
  dew: {
    exit: "the web swings out of the frame at full speed",
    enter: "the web swings in from beyond the frame at full speed",
  },
  incense: {
    exit: "played by the smoke sim, which steps with the motion",
    enter: "the ember catching, played by the smoke sim, which steps with the motion",
  },
  lanterns: { exit: "the dusk light and the flames guttering out" },
  lava: { enter: "a cold heap warming until a blob tears free" },
  marble: { enter: "redrawn on a wall-time cap, which the hand-driven clock outruns" },
  orbit: { exit: "the planet, mostly below the frame, slides out of it at full speed" },
  pearl: { exit: "played by the fluid, which steps with the motion" },
  petri: {
    exit: "the dish slides out of the frame at full speed",
    enter: "the pattern spreading over the dish as it comes home",
  },
  physarum: { enter: "growth spreading out from one point" },
  ripple: {
    exit: "played by the water sim, which steps with the motion",
    enter: "played by the water sim, which steps with the motion",
  },
};

function meanChange(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / ((a.length * 3) / 4);
}

/** Share of the passage's fastest step that its last exit steps / first entrance steps reach. */
function ends(speeds: number[], from: "start" | "end"): number {
  const peak = Math.max(...speeds, 1e-6);
  const edge = from === "end" ? speeds.slice(-2) : speeds.slice(0, 2);
  return edge.reduce((a, b) => a + b, 0) / edge.length / peak;
}

/** Set by verify.ts from LANDING_PASSAGE_SCENES: a comma list, or "" for every scene. */
declare const LANDING_PASSAGE_SCENES: string;

export async function passageSpeeds(_gl: WebGL2RenderingContext): Promise<Record<string, unknown>> {
  const only = LANDING_PASSAGE_SCENES === "" ? undefined : LANDING_PASSAGE_SCENES.split(",");
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;position:fixed;left:0;top:0`;
  document.body.append(canvas);
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) throw new Error("Renderer context unavailable");
  /** Let the page's tasks run: sheets painted on a worker arrive between frames. */
  const yieldPage = () => new Promise((resolve) => setTimeout(resolve, 5));
  const settingsFor = (id: SceneId) =>
    renderSettings(
      {
        ...defaultsFor(id),
        motion: 0,
        pixel: 1,
        view: "source" as const,
        transitions: "off" as const,
        overlap: 0,
        weave: 0.001,
      },
      paramDefaults(id),
    );
  const ids = (Object.keys(sceneDefs) as SceneId[]).filter(
    (id) => sceneDefs[id].passage !== undefined && (only === undefined || only.includes(id)),
  );
  const first = ids[0];
  if (first === undefined) throw new Error("No scene with a passage");
  const renderer = new DitherRenderer(canvas, settingsFor(first), false);
  const nativeRaf = window.requestAnimationFrame;
  let tick: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    tick = callback;
    return 1;
  };
  let now = 1000;
  const draw = (at: number): Uint8Array => {
    if (!tick) throw new Error("RAF missing");
    now = at;
    tick(at);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  /** Frames of at most 40 ms up to `at` (the renderer caps a step at 0.1 s), the last one read. */
  const drawTo = (at: number): Uint8Array => {
    while (at - now > 40) draw(now + 40);
    return draw(at);
  };
  const rows: Record<string, string> = {};
  const failures: string[] = [];
  try {
    renderer.start({ paced: false });
    for (const id of ids) {
      const passage = sceneDefs[id].passage;
      if (passage === undefined) continue;
      renderer.update(settingsFor(id));
      // The scene enters (a cut) once its program is built in the background; then at least 3 s
      // of frames, and until the picture holds still: some sims build their world over many
      // frames, showing nothing of it until done (the countryside's land, on a time budget), so a
      // still picture alone does not mean it is ready.
      let shown = draw(now + 100);
      while (renderer.waiting) {
        await yieldPage();
        shown = draw(now + 50);
      }
      for (let frame = 0, still = 0; frame < 200 && (frame < 60 || still < 3); frame++) {
        await yieldPage();
        const next = draw(now + 50);
        still = meanChange(shown, next) < 0.02 ? still + 1 : 0;
        shown = next;
      }
      // The exit starts once the incoming scene is built, drawn once and its sim ready: it began on
      // the frame that left the preparing phase.
      renderer.replayPassage();
      let last = draw(now + 10);
      for (let frame = 0; frame < 400 && renderer.passagePhase === "preparing"; frame++) {
        await yieldPage();
        last = draw(now + 20);
      }
      if (renderer.passagePhase !== "exiting") throw new Error(`${id}: its exit never started`);
      const start = now;
      const exit: number[] = [];
      for (let k = 1; k <= STEPS; k++) {
        const next = drawTo(start + (k / STEPS) * passage.exit * 995);
        exit.push(meanChange(last, next));
        last = next;
      }
      // The entrance: entered on one frame, its clock starting on the next; the 1 ms blend is
      // over by the one after.
      draw(now + 10);
      const arrive = now + 10;
      draw(arrive);
      last = draw(arrive + 1);
      const enter: number[] = [];
      for (let k = 1; k <= STEPS; k++) {
        const next = drawTo(arrive + (k / STEPS) * passage.enter * 1000);
        enter.push(meanChange(last, next));
        last = next;
      }
      draw(now + 500);
      const exitEnd = ends(exit, "end");
      const enterStart = ends(enter, "start");
      const exempt = EXEMPT[id];
      if (exitEnd < FLOOR && exempt?.exit === undefined)
        failures.push(`${id} exit ends at ${exitEnd.toFixed(2)} of its peak`);
      if (enterStart < FLOOR && exempt?.enter === undefined)
        failures.push(`${id} entrance starts at ${enterStart.toFixed(2)} of its peak`);
      rows[id] =
        `exitEnd ${exitEnd.toFixed(2)} enterStart ${enterStart.toFixed(2)}` +
        ` | exit ${exit.map((v) => v.toFixed(1)).join(" ")}` +
        ` | enter ${enter.map((v) => v.toFixed(1)).join(" ")}`;
    }
    if (failures.length > 0)
      throw new Error(`Passages that lose their speed at the seam: ${failures.join("; ")}`);
    return rows;
  } finally {
    window.requestAnimationFrame = nativeRaf;
    canvas.remove();
  }
}
