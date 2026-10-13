// A lo-fi evening seen from inside a dark room: a sash window raised onto a city at dusk, a cat on
// the sill watching it, a steaming mug, a plant, books and a stirring curtain; across the street a
// neon Manifold M hums on a rooftop. The shader is ./shader.ts; the cat's gaze is eased here on the
// CPU (uSim0).
import { feature, range, toggle, type ParamDef } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef, SceneSim, SimFrame } from "../types.ts";
import { sillGlsl } from "./shader.ts";

/** How far (in screen heights) the pointer must stray from where the cat is looking before it turns. */
const GAZE_SLACK = 0.05;
/** Seconds of a still pointer before the cat loses interest and goes back to watching the city. */
const INTEREST_SPAN = 4;
/** Time constant of the head's turn toward a new point of interest, in seconds. */
const TURN_TIME = 0.45;

/**
 * The cat's attention. A shader alone cannot ease toward a moving target or notice that the pointer
 * has stopped, so this runs on the CPU and hands the shader one rgba16f texel: where the head points
 * (scene uv, eased), how interested the cat is (0..1), and seconds since its gaze last jumped (to 60).
 * It fixes on a point and holds it until the pointer strays, then turns: still, then a quick move.
 */
function sillGaze(gl: WebGL2RenderingContext): SceneSim {
  const texture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f", filter: "nearest" });
  const texel = new Float32Array(4);
  let fixX = 0.5;
  let fixY = 0.6;
  let gazeX = fixX;
  let gazeY = fixY;
  let attention = 0;
  let lastMove = Number.NEGATIVE_INFINITY;
  let lastShift = Number.NEGATIVE_INFINITY;
  let prevX = Number.NaN;
  let prevY = Number.NaN;
  return {
    frame(frame: SimFrame) {
      const { pointer, time, aspect } = frame;
      // A scene clock that went backwards (the lab restarted it) forgets the old moments.
      if (time < lastMove) lastMove = Number.NEGATIVE_INFINITY;
      if (time < lastShift) lastShift = Number.NEGATIVE_INFINITY;
      if (pointer.inside && (pointer.pressed || Math.abs(pointer.x - prevX) + Math.abs(pointer.y - prevY) > 1e-4)) lastMove = time;
      prevX = pointer.x;
      prevY = pointer.y;
      const interested = pointer.inside && time - lastMove < INTEREST_SPAN;
      const step = frame.dt * frame.motion;
      if (step > 0) {
        if (interested && (pointer.pressed || Math.hypot((pointer.x - fixX) * aspect, pointer.y - fixY) > GAZE_SLACK)) {
          fixX = pointer.x;
          fixY = pointer.y;
          lastShift = time;
        }
        const turn = 1 - Math.exp(-step / TURN_TIME);
        gazeX += (fixX - gazeX) * turn;
        gazeY += (fixY - gazeY) * turn;
        // Interest comes quickly and fades slowly.
        attention += ((interested ? 1 : 0) - attention) * (1 - Math.exp(-step * (interested ? 2.5 : 0.5)));
      }
      texel[0] = gazeX;
      texel[1] = gazeY;
      texel[2] = attention;
      texel[3] = Math.min(time - lastShift, 60);
      texture.upload(texel);
      return [texture.texture];
    },
    dispose() {
      texture.dispose();
    },
  };
}

const params: readonly ParamDef[] = [
  feature("cat", "cat", "cat", true, "size", 0.5, "A cat on the sill with its back to you, watching the city: breathing, twitching an ear, swinging its tail over the edge. Move the pointer and it turns its head to look. Now: it looks back at you over its shoulder and blinks slowly.", { trigger: 0 }),
  range("cat", "restless", "restlessness", 0.35, "How often it moves: ear twitches, tail flicks, glances around. Low is a cat at peace; high, a cat that heard something.", { when: "cat" }),
  feature("room", "steam", "steam", true, "amount", 0.6, "Wisps curling up from the mug, drifting with the wind."),
  toggle("room", "plant", "plant", true, "A potted plant at the end of the sill, its leaves nodding in the breeze."),
  feature("room", "curtain", "curtain", true, "breeze", 0.5, "A linen curtain beside the window, stirring as the air comes in; the wind stirs it more."),
  feature("city", "lights", "city lights", true, "lit", 0.45, "Windows across the city, each switching on or off now and then as the evening goes on: how many are lit."),
  ...skyKnobs({ time: 0.8 }),
  feature("sky", "clouds", "clouds", true, "cover", 0.35, "A cloud deck over the city, lit from below by its glow at night. Rain or snow closes it over whatever the cover, lower and darker the heavier they fall."),
  ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true, lightning: 1 }),
  toggle("weather", "drops", "drops on the glass", true, "Raindrops beading and running down the panes above the open sash, each holding a tiny upside-down picture of the lit city and catching the lamp along its edge.", { when: "rain" }),
  feature("manifold", "neon", "neon M", true, "brightness", 0.8, "A neon Manifold M on the roof across the street, humming in a soft glow; now and then one stroke winks out or stutters before it catches again. In the rain it glows in the wet air and shines back from the roof, the ledge and the sill; in snow it tints the snow on its frame. Now: a stutter.", { trigger: 2 }),
];

export const sillScene: SceneDef = {
  id: "sill",
  title: "Sill",
  blurb: "A cat on the window sill, watching the city lights.",
  accent: "#ff3d7f",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    cat: { title: "Cat", blurb: "The cat on the sill: how big, how fidgety, and a look back at you." },
    room: { title: "Room", blurb: "Inside by the open window: the mug, the plant and the curtain." },
    city: { title: "City", blurb: "The skyline across the street, its windows lighting up and going dark." },
    sky: atmosphereGroups.sky,
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold sign", blurb: "A landmark of its own: a neon M humming on the roof across the street." },
  },
  glsl: sillGlsl,
  entry: "sceneSill",
  sim: sillGaze,
};
