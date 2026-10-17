// GPU regressions for the shared clouds in tiers (#1082 M12: shaders/lib/clouds.ts), run by
// concepts/landing/verify-browser.ts on real WebGL output. The tiers: each tier's functions exist from
// its tier up and not below (a scene that selects none has the lit deck), and each adopting scene
// compiles at the tier it selects and not one lower. The shadows: over the eye the deck's shadow is the
// cloud the sky shows over the sun, and a clear sky casts none. Autumn's cloud shadows (off by
// default): they only ever darken the park, they fall on part of it and move with the deck, and
// they are gone at night.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, vertexSource } from "../../shaders/index.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { sceneDefs } from "../index.ts";
import type { SceneDef } from "../types.ts";

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`cloud tiers: ${message}`);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [vertexSource, fragment].map((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(
      Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
      gl.getShaderInfoLog(shader) ?? "compile failed",
    );
    return shader;
  });
  const linked = gl.createProgram();
  for (const shader of shaders) gl.attachShader(linked, shader);
  gl.linkProgram(linked);
  check(
    Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)),
    gl.getProgramInfoLog(linked) ?? "link failed",
  );
  for (const shader of shaders) gl.deleteShader(shader);
  return linked;
}

function compiles(gl: WebGL2RenderingContext, fragment: string): boolean {
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!shader) throw new Error("Shader allocation failed");
  gl.shaderSource(shader, fragment);
  gl.compileShader(shader);
  const ok = Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS));
  gl.deleteShader(shader);
  return ok;
}

/** A scene whose entry only calls `call`, compiled with `features`. */
function gate(base: SceneDef, call: string, features: Readonly<Record<string, number>>): string {
  return fragmentSourceFor({
    ...base,
    features,
    entry: "cloudGate",
    glsl: `Shade cloudGate(vec2 uv, vec2 cell, float t) {\n  ${call};\n  return blankShade();\n}\n`,
  });
}

// Columns: the time of day across the sunlit hours (uProbeA.x + column * uProbeA.y); rows: the scene
// clock (uProbeA.w + row * 1.7 s). r: the deck's shadow over the eye, g: the deck the sky shows over
// the sun, b: the sun's height; at cover uProbeB.x, wind uProbeA.z, base uProbeB.y.
const PROBE = `
uniform vec4 uProbeA;
uniform vec4 uProbeB;

Shade cloudShadowProbe(vec2 uv, vec2 cell, float t) {
  Sky sky = skyAt(uProbeA.x + floor(cell.x) * uProbeA.y);
  float when = uProbeA.w + floor(cell.y) * 1.7;
  Shade o = blankShade();
  o.source = vec3(skyCloudShadow(sky, vec3(0.0), uProbeB.y, when, uProbeB.x, uProbeA.z),
                  skyClouds(sky, sky.sun, when, uProbeB.x, uProbeA.z).a, sky.sun.y);
  return o;
}
`;

type Uniforms = Readonly<Record<string, readonly number[]>>;

/** Draws `linked` at width x height into a float target and returns RGBA floats, rows bottom up. */
function draw(
  gl: WebGL2RenderingContext,
  linked: WebGLProgram,
  width: number,
  height: number,
  uniforms: Uniforms,
): Float32Array {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  // Unbound, so no uSim sampler (all on unit 0) reads the target it renders into.
  gl.bindTexture(gl.TEXTURE_2D, null);
  check(
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
    "float target incomplete",
  );
  gl.useProgram(linked);
  gl.viewport(0, 0, width, height);
  const base: Uniforms = {
    uRes: [width, height],
    uView: [1],
    uTime: [40],
    uMotion: [1],
    uMotionTime: [40],
    uPassage: [1, 0],
    uTriggers: Array.from({ length: 8 }, () => -1e4),
    uPrincipals: [-1, -1, 0, -1e4],
    uBg: [0.03, 0.03, 0.05],
  };
  for (const [name, value] of Object.entries({ ...base, ...uniforms })) {
    const at = gl.getUniformLocation(linked, name);
    if (at === null) continue;
    if (name === "uView") gl.uniform1i(at, value[0] ?? 0);
    else if (name === "uParams") gl.uniform4fv(at, packParams(value));
    else if (name === "uTriggers") gl.uniform1fv(at, Float32Array.from(value));
    else if (value.length === 1) gl.uniform1f(at, value[0] ?? 0);
    else if (value.length === 2) gl.uniform2fv(at, value);
    else if (value.length === 3) gl.uniform3fv(at, value);
    else gl.uniform4fv(at, value);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  return out;
}

const luma = (pixels: Float32Array, i: number): number =>
  0.2126 * (pixels[i * 4] ?? 0) +
  0.7152 * (pixels[i * 4 + 1] ?? 0) +
  0.0722 * (pixels[i * 4 + 2] ?? 0);

export function verifyCloudTiers(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const autumn = sceneDefs.autumn;

  // The tiers: the flat deck in every program, the lit deck from its tier up and in a program that
  // selects none, the shadows and the sea of tops only from their own.
  const top = { CLOUD_TIER: CLOUD_TIERS.volume };
  const flat =
    "float n = cloudFlatField(cloudDeckPoint(vec3(0.1, 0.4, 1.0), vec2(0.0), t, 0.2), cloudFlatFine(vec3(0.1, 0.4, 1.0)))";
  for (const features of [{}, { CLOUD_TIER: CLOUD_TIERS.flat }, top])
    check(
      compiles(gl, gate(autumn, flat, features)),
      `the flat deck missing with ${JSON.stringify(features)}`,
    );
  const calls: readonly [Exclude<keyof typeof CLOUD_TIERS, "flat">, string][] = [
    ["lit", "vec4 c = skyClouds(skyAt(0.5), vec3(0.1, 0.4, 1.0), t, 0.5, 0.2)"],
    ["shadows", "float s = skyCloudShadow(skyAt(0.5), vec3(1.0, -1.5, 4.0), 300.0, t, 0.5, 0.2)"],
    [
      "volume",
      "float d = cloudSeaMarch(vec3(0.0, -0.3, 1.0), CloudSea(vec2(0.0), 0.7, 0.0, 1.0, 0.45), 30.0)",
    ],
  ];
  for (const [tier, call] of calls) {
    const level = CLOUD_TIERS[tier];
    check(
      compiles(gl, gate(autumn, call, { CLOUD_TIER: level })),
      `${tier} functions missing at their own tier`,
    );
    check(compiles(gl, gate(autumn, call, top)), `${tier} functions missing at the top tier`);
    check(
      !compiles(gl, gate(autumn, call, { CLOUD_TIER: level - 1 })),
      `${tier} functions present a tier below`,
    );
    check(
      compiles(gl, gate(autumn, call, {})) === level <= CLOUD_TIERS.lit,
      `${tier} functions ${level <= CLOUD_TIERS.lit ? "missing" : "present"} without CLOUD_TIER`,
    );
  }

  // The adopters: each compiles at the tier it selects, and needs it (one tier lower fails).
  const adopters: readonly [keyof typeof sceneDefs, Exclude<keyof typeof CLOUD_TIERS, "flat">][] = [
    ["autumn", "shadows"],
    ["clouds", "volume"],
  ];
  for (const [id, tier] of adopters) {
    const def = sceneDefs[id];
    check(
      def.features?.["CLOUD_TIER"] === CLOUD_TIERS[tier],
      `${id} does not select the ${tier} tier`,
    );
    check(compiles(gl, fragmentSourceFor(def)), `${id} does not compile at its tier`);
    check(
      !compiles(
        gl,
        fragmentSourceFor({
          ...def,
          features: { ...def.features, CLOUD_TIER: CLOUD_TIERS[tier] - 1 },
        }),
      ),
      `${id} compiles a tier lower: it does not use the ${tier} tier`,
    );
  }
  // The night train draws the calm deck alone: the lit deck is not in its program.
  check(
    sceneDefs.train.features?.["CLOUD_TIER"] === CLOUD_TIERS.flat &&
      compiles(gl, fragmentSourceFor(sceneDefs.train)),
    "the train does not draw at the flat tier",
  );

  // Over the eye the deck's shadow is the cloud the sky shows over the sun, while the sun stands
  // above the ~7 degrees the shadow holds it to; a clear sky casts none.
  const probe = program(
    gl,
    fragmentSourceFor({ ...autumn, entry: "cloudShadowProbe", glsl: PROBE }),
  );
  const W = 24;
  const H = 16;
  let sunlit = 0;
  let clouded = 0;
  for (const [wind, cover] of [
    [0.2, 0.6],
    [-0.8, 0.35],
    [1, 0.9],
  ] as const) {
    const pixels = draw(gl, probe, W, H, {
      uProbeA: [0.28, 0.44 / W, wind, 3.3],
      uProbeB: [cover, 300, 0, 0],
    });
    for (let i = 0; i < W * H; i++) {
      if ((pixels[i * 4 + 2] ?? 0) < 0.125) continue;
      sunlit++;
      const shadow = pixels[i * 4] ?? Number.NaN;
      const seen = pixels[i * 4 + 1] ?? Number.NaN;
      check(
        Math.abs(shadow - seen) < 1e-3,
        `the shadow over the eye ${shadow} is not the cloud over the sun ${seen} (cell ${i}, wind ${wind})`,
      );
      if (seen > 0.5) clouded++;
    }
  }
  check(
    sunlit >= W * H && clouded >= 0.1 * sunlit && clouded <= 0.9 * sunlit,
    `the probe's sky is not partly clouded: ${clouded} of ${sunlit} cells`,
  );
  const clear = draw(gl, probe, W, H, {
    uProbeA: [0.28, 0.44 / W, 0.4, 3.3],
    uProbeB: [0, 300, 0, 0],
  });
  for (let i = 0; i < W * H; i++)
    check(clear[i * 4] === 0, `a clear sky casts a shadow at cell ${i}`);
  gl.deleteProgram(probe);

  // Autumn: off by default; on, the shadows only darken, fall on part of the park and move with the
  // deck; at night there are none. The motion clock stands still (the canopy's sway holds), and the
  // scene clock that the deck drifts on runs.
  const scene = program(gl, fragmentSourceFor(autumn));
  const P = 160;
  const Q = 90;
  const render = (knobs: Record<string, number>, time: number): Float32Array =>
    draw(gl, scene, P, Q, {
      uTime: [time],
      uMotionTime: [40],
      uParams: renderSettings(defaultsFor("autumn"), {
        ...paramDefaults("autumn"),
        clouds: 0.6,
        wind: 0.8,
        ...knobs,
      }).params,
    });
  check(paramDefaults("autumn")["shadows"] === 0, "autumn's cloud shadows are on by default");
  const shaded: boolean[][] = [];
  let darker = 0;
  for (const time of [10, 50, 90, 130]) {
    const off = render({ time: 0.55 }, time);
    const on = render({ time: 0.55, shadows: 1 }, time);
    const mask: boolean[] = [];
    for (let i = 0; i < P * Q; i++) {
      const drop = luma(off, i) - luma(on, i);
      check(drop >= -1e-6, `a cloud shadow brightened the park at pixel ${i}, ${time} s`);
      mask.push(drop > 1e-3);
      if (drop > 1e-3) darker++;
    }
    shaded.push(mask);
  }
  const share = darker / (4 * P * Q);
  check(
    share > 0.05 && share < 0.95,
    `the shadows darken ${(share * 100).toFixed(1)}% of the frame over four moments`,
  );
  const moved = shaded
    .slice(1)
    .map((mask, k) => mask.filter((value, i) => value !== shaded[k]?.[i]).length / (P * Q));
  check(
    moved.some((part) => part > 0.02),
    `the cloud shadows stand still as the deck drifts: ${moved.map((part) => part.toFixed(3)).join(", ")} of the frame`,
  );
  const night = render({ time: 0.0 }, 50);
  const nightOn = render({ time: 0.0, shadows: 1 }, 50);
  check(
    night.every((value, i) => value === nightOn[i]),
    "cloud shadows fall at night",
  );
  gl.deleteProgram(scene);
  return {
    sunlitCells: sunlit,
    cloudedCells: clouded,
    shadowedShare: Number(share.toFixed(3)),
    movedShare: moved.map((part) => Number(part.toFixed(3))),
  };
}
