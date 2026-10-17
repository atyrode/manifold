// Browser check (verify-browser.ts): shanshui on its real program and sim. Each season must wash
// the painting in a colour of its own, winter greying the sky. A long session must leave the scroll
// moving every frame (one float32 painting coordinate froze for frames at a time between ever
// larger jumps), and the change to a new section's origin must leave the picture on screen as it
// was (the section before runs on beyond the join).
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, vertexSource } from "../../shaders/index.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import { SHANSHUI_SECTION } from "./shader.ts";
import { shanshuiScene } from "./index.ts";

const WIDTH = 320;
const HEIGHT = 180;

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSourceFor(shanshuiScene)],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("shanshui sections: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "shanshui sections: compile failed");
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "shanshui sections: link failed");
  return program;
}

function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let at = 0; at < a.length; at += 4)
    if (a[at] !== b[at] || a[at + 1] !== b[at + 1] || a[at + 2] !== b[at + 2]) count++;
  return count;
}

export function verifyShanshui(gl: WebGL2RenderingContext): Record<string, unknown> {
  const knobs = { ...paramDefaults("shanshui"), speed: 1 };
  const frame = { knobs, aspect: WIDTH / HEIGHT, height: HEIGHT };
  // Screen heights a second of the fastest scroll unrolls, measured on the sim itself.
  const probe = new HeadlessSim(shanshuiScene);
  const scrollOf = (s: ArrayLike<number>): number =>
    (s[0] ?? 0) * 32 + ((s[1] ?? 0) + (s[2] ?? 0)) / 64;
  probe.step(frame);
  const start = scrollOf(probe.step({ ...frame, dt: 1 }).upload(0).data);
  const pace = scrollOf(probe.step({ ...frame, dt: 1 }).upload(0).data) - start;

  const program = compile(gl);
  const sim = new HeadlessSim(shanshuiScene, gl);
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(program);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform2f(uniform("uRes"), WIDTH, HEIGHT);
  gl.uniform1f(uniform("uTime"), 40);
  gl.uniform1f(uniform("uMotionTime"), 40);
  gl.uniform1f(uniform("uMotion"), 1);
  gl.uniform1i(uniform("uView"), 0);
  gl.uniform1i(uniform("uColor"), 2);
  gl.uniform1f(uniform("uLevels"), 5);
  gl.uniform3f(uniform("uBg"), 0.92, 0.886, 0.8);
  gl.uniform2f(uniform("uPassage"), 1, 0);
  gl.uniform1fv(uniform("uTriggers"), new Float32Array(8).fill(-1e4));
  const setKnobs = (values: Record<string, number>): void => {
    gl.uniform4fv(
      uniform("uParams"),
      packParams(renderSettings(defaultsFor("shanshui"), values).params),
    );
  };
  setKnobs(knobs);
  gl.uniform1i(uniform("uSim0"), 0);
  gl.uniform1i(uniform("uSim1"), 1);
  const draw = (textures: readonly (WebGLTexture | undefined)[]): Uint8Array => {
    textures.forEach((texture, slot) => {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    });
    gl.uniform4f(uniform("uSimOn"), textures[0] ? 1 : 0, textures[1] ? 1 : 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };

  try {
    const opening = sim.frame(frame);
    const plain = draw(opening);
    const seasonChanged = [1, 2, 3].map((season) => {
      setKnobs({ ...knobs, season });
      return differing(plain, draw(opening));
    });
    if (seasonChanged.some((count) => count < 0.02 * WIDTH * HEIGHT))
      throw new Error(
        `A shanshui season left the painting as it was: ${seasonChanged.join(", ")} pixels changed`,
      );
    // The sky: the top fifth of the frame (readPixels rows run bottom to top).
    const sky = (pixels: Uint8Array): number => {
      let sum = 0;
      for (let at = Math.floor(HEIGHT * 0.8) * WIDTH * 4; at < pixels.length; at += 4)
        sum +=
          0.2126 * (pixels[at] ?? 0) +
          0.7152 * (pixels[at + 1] ?? 0) +
          0.0722 * (pixels[at + 2] ?? 0);
      return sum / (WIDTH * Math.ceil(HEIGHT * 0.2) * 255);
    };
    setKnobs({ ...knobs, season: 4 });
    const winterSky = sky(draw(opening));
    const plainSky = sky(plain);
    if (winterSky > plainSky - 0.1)
      throw new Error(
        `Shanshui's winter left the sky unwashed: ${winterSky.toFixed(3)} against ${plainSky.toFixed(3)}`,
      );
    setKnobs(knobs);

    // A millionth of a height either side of the first section's end.
    const before = draw(sim.frame({ ...frame, dt: (SHANSHUI_SECTION - 1e-6) / pace - 1 / 60 }));
    const after = draw(sim.frame({ ...frame, dt: 2e-6 / pace }));
    const switchChanged = differing(before, after);
    if (switchChanged > 0.01 * WIDTH * HEIGHT)
      throw new Error(
        `Shanshui's new section moved the picture: ${switchChanged} of ${WIDTH * HEIGHT} pixels changed`,
      );

    // About twelve days at the fastest speed (16000 heights), then frame after frame.
    let previous = draw(sim.frame({ ...frame, dt: (16000 - SHANSHUI_SECTION) / pace }));
    let frozenFrames = 0;
    for (let i = 0; i < 4; i++) {
      const next = draw(sim.frame(frame));
      if (differing(previous, next) === 0) frozenFrames++;
      previous = next;
    }
    if (frozenFrames > 0)
      throw new Error(
        `Shanshui's scroll stood still in ${frozenFrames} of 4 frames after a long session`,
      );
    return {
      seasonChanged,
      plainSky,
      winterSky,
      switchChanged,
      pixels: WIDTH * HEIGHT,
      frozenFrames,
    };
  } finally {
    sim.dispose();
    gl.deleteProgram(program);
    for (const slot of [1, 0]) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}
