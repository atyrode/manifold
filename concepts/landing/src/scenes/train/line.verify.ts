// Real-WebGL regression for the train's line character (R39, the `line` knob): the land is drawn to
// match the line, on the actual scene shader. The hills' and the ridge's skylines are lowest on the
// rural line and highest on the mountain line; on the mountain line the hills rise over a tunnel's
// stretch (the hill it goes through) and are untouched well beyond it, while the country line draws
// exactly what it drew with or without a tunnel in its timetable. Out of a tunnel's mouth straight
// onto a viaduct, no cutting rock stands over the bridge (it does where there is none); and coming
// out of a long tunnel with the next one just across a viaduct, the train is still in the one it is
// in, though the next one's middle is nearer. The shared birds fly over the line's country by day
// (some cross the window over a few minutes of the motion clock) and not at night or while off.
// Small entries draw those parts on their own, from a uSim0 timetable laid out as sim.ts documents.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { DataTexture } from "../../sims/texture.ts";
import { loadScene } from "../index.ts";
import { BASE, compile, draw, WIDTH } from "./motion-clock.verify.ts";
import { TRAIN_BLOCK, TRAIN_BRIDGE, TRAIN_TEXELS, TRAIN_TUNNEL } from "./sim.ts";

const trainScene = await loadScene("train");

function fail(message: string): never {
  throw new Error(`train line: ${message}`);
}

/** The train 100 m into block 20 at 4 m/s; events as [start (m from the train), length, kind]. */
function timetable(
  gl: WebGL2RenderingContext,
  events: readonly (readonly [number, number, number])[],
): DataTexture {
  const s = 20 * TRAIN_BLOCK + 100;
  const data = new Float32Array(TRAIN_TEXELS * 4);
  data.set([20, 100, 0, 4], 0);
  for (const [k, [from, length, kind]] of events.entries()) {
    const start = s + from;
    const block = Math.floor(start / TRAIN_BLOCK);
    data.set([block, start - block * TRAIN_BLOCK, length, kind, 0.5, 100, 0, 0], (2 + 2 * k) * 4);
  }
  const texture = new DataTexture(gl, {
    width: TRAIN_TEXELS,
    height: 1,
    format: "rgba16f",
    filter: "nearest",
  });
  texture.upload(data);
  return texture;
}

/** The knobs at noon on a line, and any others. */
function onLine(line: number, more: Readonly<Record<string, number>> = {}): readonly number[] {
  return renderSettings(defaultsFor("train"), {
    ...paramDefaults("train"),
    time: 0.5,
    line,
    ...more,
  }).params;
}

/** One row's red and green channels, column by column. */
function row(bytes: Uint8Array): { r: number[]; g: number[] } {
  const r: number[] = [];
  const g: number[] = [];
  for (let x = 0; x < WIDTH; x++) {
    r.push(bytes[x * 4] ?? 0);
    g.push(bytes[x * 4 + 1] ?? 0);
  }
  return { r, g };
}

/** Metres along the line at column x of the skyline part. */
const along = (x: number): number => ((x + 0.5) / WIDTH - 0.5) * 2400;

export function verifyTrainLine(gl: WebGL2RenderingContext): Record<string, unknown> {
  const linked = compile(
    gl,
    trainScene,
    "regressionTrainLine",
    `
    uniform int regressionPart;
    Shade regressionTrainLine(vec2 uv, vec2 cell, float t) {
      trainPx = 1.0 / uRes.y;
      trainRead(t);
      trainLine();
      trainSalt = mod(K_route, 1000.0) * 0.731;
      trainPassage();
      trainEyeOff = vec2(0.0);
      if (regressionPart == 0) {
        // The skylines over 2.4 km of the line: hills (m) in red, the ridge (10 m) in green.
        float d = (uv.x - 0.5) * 2400.0;
        return shadeOf(vec3(trainHillsH(d) / 255.0, trainRidgeH(d) / 2550.0, 0.0), 0.0, 0.0);
      }
      vec2 o = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
      // The birds crossing the window, in red.
      if (regressionPart == 2) return shadeOf(vec3(trainBirds(o).cover, 0.0, 0.0), 0.0, 0.0);
      // What stands right outside the window: the tunnel's wall in red, the cutting in green.
      float hitZ = 1e6;
      trainTunnelScene(o, t, vec3(0.0), hitZ);
      return shadeOf(vec3(abs(hitZ - TRAIN_WALL_Z) < 0.01 ? 1.0 : 0.0, abs(hitZ - TRAIN_CUT_Z) < 0.01 ? 1.0 : 0.0, 0.0), 0.0, 0.0);
    }`,
  );
  const part = gl.getUniformLocation(linked, "regressionPart");
  const none = timetable(gl, []);
  const tunnel = timetable(gl, [[-100, 300, TRAIN_TUNNEL]]);
  // Out of a tunnel 25 m back onto a viaduct begun 5 m back; and the same mouth with no viaduct.
  const viaduct = timetable(gl, [
    [-345, 320, TRAIN_TUNNEL],
    [-5, 200, TRAIN_BRIDGE],
  ]);
  const mouth = timetable(gl, [[-345, 320, TRAIN_TUNNEL]]);
  // 10 m from the end of a 600 m tunnel, a 90 m viaduct, then a 200 m one: its middle is nearer.
  const pair = timetable(gl, [
    [-590, 600, TRAIN_TUNNEL],
    [35, 90, TRAIN_BRIDGE],
    [150, 200, TRAIN_TUNNEL],
  ]);
  try {
    gl.useProgram(linked);
    gl.uniform1i(part, 0);
    const sky = (line: number, sim: DataTexture) =>
      row(draw(gl, linked, onLine(line), sim.texture, BASE));
    const country = sky(0, none);
    const rural = sky(1, none);
    const mountain = sky(2, none);
    const countryTunnel = sky(0, tunnel);
    const mountainTunnel = sky(2, tunnel);
    for (let x = 0; x < WIDTH; x++) {
      const [c, r, m] = [country.r[x] ?? 0, rural.r[x] ?? 0, mountain.r[x] ?? 0];
      if (countryTunnel.r[x] !== c || countryTunnel.g[x] !== country.g[x])
        fail(`the country line's skyline moved for a tunnel at ${along(x)} m`);
      if (!(r <= c && c <= m))
        fail(`hills at ${along(x)} m: rural ${r}, country ${c}, mountain ${m} m`);
      const [cr, rr, mr] = [country.g[x] ?? 0, rural.g[x] ?? 0, mountain.g[x] ?? 0];
      if (!(rr < cr && cr < mr))
        fail(`ridge at ${along(x)} m: rural ${rr}, country ${cr}, mountain ${mr} (10 m)`);
      const rise = (mountainTunnel.r[x] ?? 0) - m;
      const d = along(x);
      if (d > -100 && d < 200 && rise < 60)
        fail(`the hill over a mountain tunnel rose ${rise} m at ${d} m`);
      if ((d < -560 || d > 660) && rise !== 0)
        fail(`the hills moved ${rise} m at ${d} m, far beyond a tunnel`);
    }
    const highest = (values: number[]): number => Math.max(...values);
    if (highest(mountain.r) < 1.8 * highest(country.r))
      fail(
        `mountain hills top out at ${highest(mountain.r)} m against the country's ${highest(country.r)} m`,
      );

    gl.uniform1i(part, 1);
    const share = (sim: DataTexture, channel: 0 | 1): number => {
      const bytes = draw(gl, linked, onLine(2), sim.texture, BASE);
      let n = 0;
      for (let i = channel; i < bytes.length; i += 4) if ((bytes[i] ?? 0) > 127) n++;
      return n / (bytes.length / 4);
    };
    const overViaduct = share(viaduct, 1);
    const byMouth = share(mouth, 1);
    if (overViaduct > 0)
      fail(
        `cutting rock stands over the viaduct (${(overViaduct * 100).toFixed(0)}% of the window)`,
      );
    if (byMouth < 0.3)
      fail(
        `no cutting outside a tunnel's mouth without a viaduct (${(byMouth * 100).toFixed(0)}%): the check would be vacuous`,
      );
    const inTunnel = share(pair, 0);
    if (inTunnel < 0.9)
      fail(
        `10 m before a tunnel's end the window shows its wall on only ${(inTunnel * 100).toFixed(0)}%`,
      );

    gl.uniform1i(part, 2);
    // Bird pixels over the window across ten minutes of the motion clock, a frame every 15 s.
    const birds = (more: Readonly<Record<string, number>>): number => {
      let n = 0;
      for (let m = 15; m <= 600; m += 15) {
        const bytes = draw(gl, linked, onLine(1, more), none.texture, {
          time: m,
          motionTime: m,
          fallTime: m,
          motion: 1,
        });
        for (let i = 0; i < bytes.length; i += 4) if ((bytes[i] ?? 0) > 127) n++;
      }
      return n;
    };
    const on = { birds: 1, "birds-amount": 1 };
    const byDay = birds(on);
    if (byDay === 0) fail("no bird crossed the rural line's window in ten minutes of a day");
    const atNight = birds({ ...on, time: 0 });
    if (atNight > 0) fail(`${atNight} bird pixels at midnight`);
    const off = birds({});
    if (off > 0) fail(`${off} bird pixels with the birds off`);
    return {
      trainLine: {
        hillsTop: {
          rural: highest(rural.r),
          country: highest(country.r),
          mountain: highest(mountain.r),
        },
        cutByMouth: byMouth,
        wallInTunnel: inTunnel,
        birdPixelsByDay: byDay,
      },
    };
  } finally {
    gl.deleteProgram(linked);
    for (const texture of [none, tunnel, viaduct, mouth, pair]) texture.dispose();
  }
}
