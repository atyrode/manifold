// Real-WebGL check of the dew web's bin lists: on a small frame, where the hub's bins need more than
// one page, the shader's reader (binListsGlsl, through the dew program, the web's field 1 and the
// header's pages in its row of the records atlas) must walk exactly the lists the sim built, page
// after page. The expected lists come from a twin of the same sim run on the headless stand-in
// context, which keeps its uploads.
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { fragmentSourceFor, sceneFeatures, vertexSource } from "../../shaders/index.ts";
import { BIN_PAGE } from "../../sims/bins.ts";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { DEW_HEAD_AT } from "./sim.ts";

const { glslFor, ...dewScene } = await loadScene("dew");

/** The composed sim's slots (src/composer/sim.ts): the atlas, then the web's two fields. */
const ATLAS = 1;
const LISTS = 3;
/** The web's row of the atlas: the one after the composer's own. */
const ROW = 1;

function linked(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("dew bins: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "dew bins: compile failed");
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "dew bins: link failed");
  return program;
}

export function verifyDewBins(gl: WebGL2RenderingContext): Record<string, unknown> {
  if (glslFor === undefined) throw new Error("dew bins: the scene is not composed");
  const frame: HeadlessFrame = {
    dt: 1 / 30,
    aspect: 480 / 270,
    height: 270,
    pointer: { inside: false },
  };
  const twin = new HeadlessSim(dewScene);
  const sim = new HeadlessSim(dewScene, gl);
  let textures: readonly (WebGLTexture | undefined)[] = [];
  for (let f = 0; f < 30; f++) {
    textures = sim.frame(frame);
    twin.step(frame);
  }
  const lists = twin.upload(LISTS);
  const header = (ROW * ATLAS_WIDTH + DEW_HEAD_AT) * 4;
  const pages = Math.max(1, Math.round(twin.upload(ATLAS).data[header + 10] ?? 0));
  const rows = lists.width / BIN_PAGE;
  const cols = lists.height / pages;

  // One pixel per bin: how many entries the shader walks there, their ids' sum mod 251, the pages.
  const features = sceneFeatures(dewScene);
  const program = linked(
    gl,
    fragmentSourceFor(
      {
        ...dewScene,
        entry: "regressionDewBins",
        glsl: `${glslFor(features)}
      Shade regressionDewBins(vec2 uv, vec2 cell, float t) {
        int pages = max(1, int(webRecord(DEW_HEAD_AT + 2, 0).z + 0.5));
        int rows = textureSize(webField1, 0).x / BIN_PAGE;
        ivec3 bin = binListsAt(webField1, pages, (floor(cell) + 0.5) / float(rows));
        float count = 0.0;
        float sum = 0.0;
        for (int k = 0; k < BIN_PAGE * pages; k++) {
          float id = binListsEntry(webField1, bin, k);
          if (id == 0.0) break;
          count += 1.0;
          sum = mod(sum + abs(id), 251.0);
        }
        return shadeOf(vec3(count, sum, float(pages)) / 255.0, 0.0, 0.0);
      }`,
      },
      features,
    ),
  );
  gl.canvas.width = cols;
  gl.canvas.height = rows;
  gl.viewport(0, 0, cols, rows);
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uRes"), cols, rows);
  gl.uniform1i(gl.getUniformLocation(program, "uView"), 1);
  gl.uniform4f(gl.getUniformLocation(program, "uSimOn"), 1, 1, 1, 1);
  for (let slot = 0; slot < 4; slot++) {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, textures[slot] ?? null);
    gl.uniform1i(gl.getUniformLocation(program, `uSim${slot}`), slot);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Uint8Array(cols * rows * 4);
  gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  for (let slot = 0; slot < 4; slot++) {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.deleteProgram(program);
  sim.dispose();
  twin.dispose();

  let fullest = 0;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      let count = 0;
      let sum = 0;
      for (let k = 0; k < BIN_PAGE * pages; k++) {
        const id =
          lists.data[
            (i + Math.floor(k / BIN_PAGE) * cols) * lists.width + j * BIN_PAGE + (k % BIN_PAGE)
          ] ?? 0;
        if (id === 0) break;
        count++;
        sum = (sum + Math.abs(id)) % 251;
      }
      fullest = Math.max(fullest, count);
      const at = (j * cols + i) * 4;
      const seen = [pixels[at], pixels[at + 1], pixels[at + 2]];
      if (seen[0] !== count || seen[1] !== sum || seen[2] !== pages) {
        throw new Error(
          `dew bins: bin ${i},${j} walked ${seen.join("/")} on the GPU, built ${count}/${sum}/${pages}`,
        );
      }
    }
  }
  if (fullest <= BIN_PAGE)
    throw new Error(`dew bins: the fixture's fullest bin holds ${fullest}, not past one page`);
  return { bins: `${cols}x${rows}`, pages, fullest };
}
