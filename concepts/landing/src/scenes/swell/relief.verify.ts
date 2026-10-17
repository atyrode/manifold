// GPU regression for Swell's wave relief (#1082 R02): the bounded march must find where each ray
// first meets the lifted sea (no crest stepped over, the hit on the surface) and must keep the
// waves below the camera, at the default sea, the tallest swell in the hardest wind, and the
// entrance's low camera over its rolling wave. It runs the scene's own GLSL, with the relief's code
// compiled in (SWELL_RELIEF); registered in verify-browser.ts.
import { fragmentSourceFor, packParams, sceneFeatures, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { loadScene } from "../index.ts";

const swellScene = await loadScene("swell");

const WIDTH = 240;
const HEIGHT = 60;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
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

export function verifySwellRelief(gl: WebGL2RenderingContext): Record<string, unknown> {
  // One ray per pixel, fanning across and down from just under the horizon to steeply down; red: the
  // march's hit lies on the sea, green: no point of the ray before it is a centimetre (0.01 camera
  // heights) or more under the sea, sampled densely, blue: the waves stay below the camera.
  const linked = program(
    gl,
    fragmentSourceFor(
      {
        ...swellScene,
        entry: "regressionSwellRelief",
        glsl:
          swellScene.glsl +
          `
      uniform vec3 regressionCamera;
      Shade regressionSwellRelief(vec2 uv, vec2 cell, float t) {
        vec3 rd = normalize(vec3((uv.x - 0.5) * 1.8, mix(-0.44, -0.002, uv.y), 1.6));
        float camH = regressionCamera.x;
        float amp = regressionCamera.y;
        float front = regressionCamera.z;
        float gain = SWELL_BREEZE.x + SWELL_BREEZE.y * abs(K_wind);
        float heading = 0.5 * TAU - SWELL_VEER * clamp(SWELL_VEER_GAIN * K_wind, -1.0, 1.0);
        SwellSea sea = swellSea(K_height * 2.0, gain, heading);
        vec3 relief = swellRelief(K_relief, camH, sea, amp);
        float s = swellMarch(camH, rd, relief, t, sea, front, amp);
        float onSea = abs(swellGap(s, camH, rd, relief.x, t, sea, front, amp)) < 0.002 ? 1.0 : 0.0;
        float first = 1.0;
        for (int k = 1; k < 256; k++) {
          if (swellGap(s * float(k) / 256.0, camH, rd, relief.x, t, sea, front, amp) < -0.01) first = 0.0;
        }
        return shadeOf(vec3(onSea, first, relief.y < camH ? 1.0 : 0.0), 0.0, 0.0);
      }`,
      },
      { ...sceneFeatures(swellScene), SWELL_RELIEF: 1 },
    ),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  const at = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uView"), 1);
  gl.uniform3f(at("uBg"), 0, 0, 0);
  // At rest the march reaches the sea within its steps; during the entrance, with the camera low over
  // the long rolling wave (camera: its height, the wave's height and how far ahead its crest is, in
  // camera heights: the entrance's tallest roll part way in), grazing rays may run out of steps while
  // skimming crests (they stop there, by design), but must still never step over one, and the waves
  // must stay under the camera.
  const cases = [
    { name: "default", knobs: { relief: 1 }, camera: [1, 0, 0], atRest: true },
    { name: "tallest", knobs: { relief: 1, height: 1, wind: 1 }, camera: [1, 0, 0], atRest: true },
    {
      name: "entranceTallest",
      knobs: { relief: 1, height: 1, wind: 1 },
      camera: [0.35, 0.18, 4.5],
      atRest: false,
    },
    // A calm sea, so the rolling wave alone sets how high the relief may go below the low camera.
    {
      name: "entranceCalm",
      knobs: { relief: 1, height: 0.05, wind: 0 },
      camera: [0.35, 0.18, 4.5],
      atRest: false,
    },
  ] as const;
  const result: Record<string, unknown> = {};
  for (const { name, knobs, camera, atRest } of cases) {
    gl.uniform4fv(
      at("uParams"),
      packParams(
        renderSettings(defaultsFor("swell"), { ...paramDefaults("swell"), ...knobs }).params,
      ),
    );
    gl.uniform3f(at("regressionCamera"), camera[0], camera[1], camera[2]);
    let offSea = 0;
    let skipped = 0;
    let swamped = 0;
    for (const time of [17.5, 90.25]) {
      gl.uniform1f(at("uTime"), time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
      for (let index = 0; index < bytes.length; index += 4) {
        if ((bytes[index] ?? 0) < 128) offSea++;
        if ((bytes[index + 1] ?? 0) < 128) skipped++;
        if ((bytes[index + 2] ?? 0) < 128) swamped++;
      }
    }
    const rays = 2 * WIDTH * HEIGHT;
    check(swamped === 0, `Swell relief (${name}) lifted the waves to the camera`);
    check(
      skipped <= rays / 1000,
      `Swell relief (${name}) stepped over crests on ${skipped} of ${rays} rays`,
    );
    check(
      !atRest || offSea <= rays / 100,
      `Swell relief (${name}) stopped short of the sea on ${offSea} of ${rays} rays`,
    );
    result[name] = { rays, skipped, offSea };
  }
  gl.deleteProgram(linked);
  return result;
}
