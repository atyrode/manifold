// GPU check (verify-browser.ts): the limestone slot frames the waterfall without hiding it. Through
// the scene's own functions (fallsSetGorge, fallsSlot, fallsSlotFit, fallsCurtain, fallsAt): the
// falling sheet stays inside the slot's opening at every flow and wind on a 16:9 frame, and at the
// default flow on a 4:3 one, with or without the carved M's horn parting it, while the walls close
// in on both sides of the frame; the default basalt cliff stands open.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, vertexSource } from "../../shaders/index.ts";
import { loadScene } from "../index.ts";

const fallsScene = await loadScene("falls");

const HEIGHT = 180;

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("falls gorge: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "falls gorge: compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(linked) ?? "falls gorge: link failed");
  return linked;
}

export function fallsGorgeCheck(gl: WebGL2RenderingContext): Record<string, unknown> {
  // Red: a slot wall (or the water in front of one, or the woods over it) is nearer than the back
  // wall here. Green: the falling sheet's coverage.
  const linked = compile(
    gl,
    fragmentSourceFor({
      ...fallsScene,
      entry: "regressionFallsGorge",
      glsl: `${fallsScene.glsl}
    Shade regressionFallsGorge(vec2 uv, vec2 cell, float t) {
      fallsSetGorge(K_gorge);
      float aspect = uRes.x / uRes.y;
      vec2 q = vec2((uv.x - 0.5) * aspect, uv.y);
      vec4 slot = fallsGeo.kind > 1.5 ? fallsSlot(q, fallsSlotFit(aspect)) : vec4(0.0);
      float sheen = 0.0;
      float water = fallsCurtain(q, fallsAt(aspect), K_flow, K_mark, K_wind, uMotionTime, sheen).x;
      return shadeOf(vec3(slot.x != 0.0 ? 1.0 : 0.0, water, 0.0), 0.0, 0.0);
    }`,
    }),
  );
  gl.useProgram(linked);
  gl.uniform1i(gl.getUniformLocation(linked, "uView"), 1);
  gl.uniform1f(gl.getUniformLocation(linked, "uMotion"), 1);
  gl.uniform2f(gl.getUniformLocation(linked, "uPassage"), 1, 0);
  const cases: { width: number; gorge: number; flow: number; wind: number; mark: number }[] = [];
  for (const flow of [0.2, 0.55, 1])
    for (const wind of [-1, 0, 1])
      for (const mark of [0, 1]) cases.push({ width: 320, gorge: 2, flow, wind, mark });
  for (const wind of [-1, 1])
    for (const mark of [0, 1]) cases.push({ width: 240, gorge: 2, flow: 0.55, wind, mark });
  cases.push({ width: 320, gorge: 0, flow: 1, wind: 1, mark: 1 });
  const result: Record<string, unknown> = {};
  for (const c of cases) {
    gl.canvas.width = c.width;
    gl.canvas.height = HEIGHT;
    gl.viewport(0, 0, c.width, HEIGHT);
    gl.uniform2f(gl.getUniformLocation(linked, "uRes"), c.width, HEIGHT);
    const knobs = {
      ...paramDefaults("falls"),
      gorge: c.gorge,
      flow: c.flow,
      wind: c.wind,
      mark: c.mark,
    };
    gl.uniform4fv(
      gl.getUniformLocation(linked, "uParams"),
      packParams(renderSettings(defaultsFor("falls"), knobs).params),
    );
    let hidden = 0;
    let water = 0;
    let walls = 0;
    const bytes = new Uint8Array(c.width * HEIGHT * 4);
    for (const time of [7, 31.5]) {
      gl.uniform1f(gl.getUniformLocation(linked, "uTime"), time);
      gl.uniform1f(gl.getUniformLocation(linked, "uMotionTime"), time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, c.width, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      for (let i = 0; i < bytes.length; i += 4) {
        const wall = (bytes[i] ?? 0) > 127;
        const sheet = (bytes[i + 1] ?? 0) > 127;
        if (wall) walls++;
        if (sheet) water++;
        if (wall && sheet) hidden++;
      }
    }
    const name = `${c.width}x${HEIGHT} gorge ${c.gorge} flow ${c.flow} wind ${c.wind} mark ${c.mark}`;
    // Both sides of the frame, at three fifths of its height: a wall in the slot, open in the basalt.
    const row = Math.round(HEIGHT * 0.6) * c.width * 4;
    const sides = [(bytes[row] ?? 0) > 127, (bytes[row + (c.width - 1) * 4] ?? 0) > 127];
    result[name] = { water, walls, hidden };
    if (water < 400)
      throw new Error(`falls gorge (${name}): the falling sheet is missing (${water} cells)`);
    if (hidden > 0)
      throw new Error(
        `falls gorge (${name}): ${hidden} cells of the falling sheet lie behind a slot wall`,
      );
    if (c.gorge === 2 && !(sides[0] && sides[1]))
      throw new Error(
        `falls gorge (${name}): the slot's walls do not close in on both sides (left ${sides[0]}, right ${sides[1]})`,
      );
    if (c.gorge === 0 && walls > 0)
      throw new Error(`falls gorge (${name}): the basalt cliff has ${walls} cells of slot wall`);
  }
  gl.deleteProgram(linked);
  return result;
}
