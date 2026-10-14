// GPU simulation engine for scene sims (see scenes/types.ts SceneSim): float render targets,
// ping-pong pairs, fullscreen passes and particle scatter passes, all on the renderer's WebGL2
// context. For fields and swarms too big for the CPU: smoke and films (sims/fluid.ts builds a fluid
// solver on this), reaction–diffusion, erosion, hundreds of thousands of agents.
//
// Availability. `GpuCompute.create(gl)` returns undefined, without throwing, when the context
// cannot render to float textures (EXT_color_buffer_float), so a scene can fall back to something
// cheaper. 16-bit float targets always filter linearly; 32-bit ones only with
// OES_texture_float_linear (otherwise a "linear" 32-bit target quietly becomes "nearest": check
// `RenderTarget.filter`) and only blend with EXT_float_blend (`GpuCompute.floatBlend`), so deposit
// into 16-bit targets. 32-bit targets are for state that needs the precision: particle positions,
// reaction–diffusion.
//
// GL state contract. The renderer calls `sim.frame()`, then sets the viewport, its program and the
// texture units it samples, and draws with the vertex array it bound at startup. Every call here:
//   - returns with the FRAMEBUFFER binding null and BLEND disabled (blend equation FUNC_ADD, blend
//     func ONE, ZERO);
//   - may leave changed: the viewport, the current program, the active texture unit, the 2D
//     texture bound on units 0..(samplers - 1), and the pixel store UNPACK_ALIGNMENT 1,
//     UNPACK_FLIP_Y_WEBGL false, UNPACK_PREMULTIPLY_ALPHA_WEBGL false;
//   - never binds a vertex array or a buffer: draws use whichever vertex array is bound and no
//     attributes (vertices come from gl_VertexID);
//   - assumes depth, stencil and scissor tests, face culling and rasterizer discard are off and the
//     colour mask is full (the renderer never changes them).
//
// Layout. Rows run bottom to top: row 0 is uv.y = 0, as everywhere in the lab. A pass shades one
// fragment per target texel and vUv is that texel's centre, (i + 0.5) / size; sampling a linear
// texture exactly there returns the texel itself.
//
// Pass GLSL. `gpu.pass(body)` compiles this preamble followed by `body`, which declares its own
// uniforms and defines `void main()` writing fragColor:
//     #version 300 es
//     precision highp float; precision highp int;
//     precision highp sampler2D; precision highp isampler2D; precision highp usampler2D;
//     in vec2 vUv;           // 0..1 over the target, texel centres
//     out vec4 fragColor;    // channels the target lacks are dropped
//     uniform vec2 uTexel;   // 1 / target size, set on every run
//     uniform vec2 uSize;    // target size in texels, set on every run
// gl_FragCoord.xy is the texel's centre in texels, so `texelFetch(uState, ivec2(gl_FragCoord.xy), 0)`
// reads the same texel of a same-sized state texture (the particle update pass).
//
// Scatter GLSL. `gpu.scatter(body)` draws `count` points, one per particle, with no attributes.
// The vertex shader is the same precision preamble, then
//     uniform vec2 uTexel; uniform vec2 uSize;   // of the target
//     uniform float uPointSize;                  // the run's pointSize
//     float pointSize;                           // this point's size in texels; may be changed
//     ivec2 particleTexel(int id, ivec2 size);   // texel of particle id: row by row from the bottom
// then `body`, which must define
//     bool particle(int id, out vec2 uv, out vec4 value);
// returning false to skip the particle; it lands at `uv` (0..1) and adds `value` into the target
// (blend "add" by default; "max" keeps the largest). The default fragment writes `value` over the
// whole point ("square") or under a smooth disc, `value` at its centre and 0 at its rim ("soft");
// `fragment` replaces it with a body that reads `in vec4 vValue` and gl_PointCoord and writes
// fragColor. A wide point whose centre leaves the target is drawn in part on some GPUs and dropped
// whole on others, so keep big splats inside the frame (or fade them out near its edges).
//
// Uniforms and textures. Programs list their active uniforms when linked. `set(values)` writes
// uniforms now and `bind(textures)` remembers which texture each sampler reads; both persist across
// runs, and `run` applies its `uniforms` and `textures` the same way before drawing. Values: a
// number or boolean for a scalar, an array or typed array for vectors, matrices (column-major) and
// arrays (a shorter array fills the first elements). A name the source never declares throws (a
// typo guard); a declared one the compiler dropped is ignored. Every sampler the program uses must
// have a texture when it runs, and none may be the target itself. A texture is a RenderTarget, a
// PingPong (its read side, looked up at draw time) or a raw WebGLTexture; prefer the first two,
// which stay valid across resizes. Built-in names (uTexel, uSize, uPointSize, vUv, vValue,
// fragColor, pointSize, particleTexel) are reserved.
//
// Ping-pong. Running a pass into a PingPong draws into its write side and swaps, so `read` (and
// `texture`) is always the latest state: `step.run(state, { textures: { uState: state } })` is one
// step of state = f(state). Scattering into a PingPong adds into its read side, the current state.
//
// Errors are GpuError: compile and link failures carry the info log and the numbered source (the
// offending lines marked with >); misuse (unknown uniform, missing texture, feedback, bad sizes)
// says what was wrong.
//
// Example: Gray–Scott reaction–diffusion (u, v in r, g). rg32f, because half floats round away
// the tiny per-step changes the reaction lives on.
//
//   const gpu = GpuCompute.create(gl);
//   if (!gpu) return fallbackSim(gl);
//   const { width, height } = gridSize(16 / 9, 256);
//   const grid = gpu.pingPong({ width, height, format: "rg32f", wrap: "repeat" });
//   const start = new Float32Array(width * height * 2);
//   for (let i = 0; i < width * height; i++) start[i * 2] = 1;               // u = 1 everywhere
//   for (let y = -4; y < 4; y++) for (let x = -4; x < 4; x++)                 // a patch of v
//     start[(((height >> 1) + y) * width + (width >> 1) + x) * 2 + 1] = 0.5;
//   grid.seed(start);
//   const react = gpu.pass(`
//     uniform sampler2D uState;
//     uniform float uFeed;
//     uniform float uKill;
//     void main() {
//       vec2 s = texture(uState, vUv).xy;
//       vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);
//       vec2 lap = texture(uState, vUv + dx).xy + texture(uState, vUv - dx).xy
//                + texture(uState, vUv + dy).xy + texture(uState, vUv - dy).xy - 4.0 * s;
//       float r = s.x * s.y * s.y;
//       fragColor = vec4(s + vec2(0.2 * lap.x - r + uFeed * (1.0 - s.x),
//                                 0.1 * lap.y + r - (uFeed + uKill) * s.y), 0.0, 1.0);
//     }`, "gray-scott");
//   react.set({ uFeed: 0.037, uKill: 0.06 }).bind({ uState: grid });      // both persist
//   return {
//     frame(frame) {
//       const steps = Math.min(32, Math.round(frame.dt * frame.motion * 240));
//       for (let i = 0; i < steps; i++) react.run(grid);       // reads grid.read, writes, swaps
//       return [grid.texture];                                 // read it every frame: it swaps
//     },
//     dispose: () => gpu.dispose(),                            // frees everything made with gpu
//   };
//
// Example: physarum. 512×512 agents (262,144) in an rgba32f state texture (xy position in uv,
// z heading), sensing an r16f trail ahead and to either side, turning toward the strongest smell,
// stepping, then depositing into the trail, which blurs and fades.
//
//   const agents = gpu.pingPong({ width: 512, height: 512, format: "rgba32f", filter: "nearest" });
//   agents.seed(startAgents);                         // Float32Array(512 * 512 * 4), seeded PRNG
//   const trail = gpu.pingPong({ ...gridSize(aspect, 360), format: "r16f", wrap: "repeat" });
//   const move = gpu.pass(`
//     uniform sampler2D uAgents;
//     uniform sampler2D uTrail;
//     uniform float uAspect, uSensor, uAngle, uSpeed;
//     vec2 ahead(float heading) { return vec2(cos(heading) / uAspect, sin(heading)); }
//     void main() {
//       vec4 a = texelFetch(uAgents, ivec2(gl_FragCoord.xy), 0);
//       float left = texture(uTrail, a.xy + uSensor * ahead(a.z + uAngle)).x;
//       float front = texture(uTrail, a.xy + uSensor * ahead(a.z)).x;
//       float right = texture(uTrail, a.xy + uSensor * ahead(a.z - uAngle)).x;
//       float heading = a.z + (front >= max(left, right) ? 0.0 : left > right ? uAngle : -uAngle);
//       fragColor = vec4(fract(a.xy + uSpeed * ahead(heading)), heading, a.w);
//     }`, "physarum move");
//   const deposit = gpu.scatter(`
//     uniform sampler2D uAgents;
//     uniform float uAmount;
//     bool particle(int id, out vec2 uv, out vec4 value) {
//       uv = texelFetch(uAgents, particleTexel(id, textureSize(uAgents, 0)), 0).xy;
//       value = vec4(uAmount);
//       return true;
//     }`, { name: "physarum deposit" });
//   const diffuse = gpu.pass(`
//     uniform sampler2D uTrail;
//     uniform float uKeep;
//     void main() {
//       vec4 sum = vec4(0.0);
//       for (int y = -1; y <= 1; y++)
//         for (int x = -1; x <= 1; x++) sum += texture(uTrail, vUv + vec2(x, y) * uTexel);
//       fragColor = uKeep * sum / 9.0;
//     }`, "physarum diffuse");
//   // frame(): sense and move, deposit into the current trail, then blur and fade it.
//   move.run(agents, {
//     textures: { uAgents: agents, uTrail: trail },
//     uniforms: { uAspect: frame.aspect, uSensor: 0.02, uAngle: 0.6, uSpeed: 0.3 * frame.dt },
//   });
//   deposit.run(trail, { count: 512 * 512, textures: { uAgents: agents }, uniforms: { uAmount: 0.03 } });
//   diffuse.run(trail, { textures: { uTrail: trail }, uniforms: { uKeep: 0.92 } });
//   return [trail.texture];

export type TargetFormat = "r8" | "rgba8" | "r16f" | "rg16f" | "rgba16f" | "r32f" | "rg32f" | "rgba32f";
export type TargetFilter = "linear" | "nearest";
/** Edge behaviour of a target when sampled outside 0..1: per axis with "repeat-x" / "repeat-y". */
export type TargetWrap = "clamp" | "repeat" | "repeat-x" | "repeat-y";
/** How a draw combines with what the target holds: replace, add, or keep the larger. */
export type BlendMode = "none" | "add" | "max";
/** A scalar, or an array / typed array for vectors, matrices and uniform arrays. */
export type UniformValue = number | boolean | ArrayLike<number>;
/** What a sampler reads: a target, a ping-pong pair (its read side) or a raw texture. */
export type TextureSource = RenderTarget | PingPong | WebGLTexture;

export interface TargetOptions {
  /** Whole texels, 1..MAX_TEXTURE_SIZE. */
  width: number;
  height: number;
  format: TargetFormat;
  /** Default "linear" (32-bit formats fall back to "nearest" without OES_texture_float_linear). */
  filter?: TargetFilter;
  /** Default "clamp". */
  wrap?: TargetWrap;
}

export interface RunOptions {
  /** Applied with `set` before drawing (they persist). */
  uniforms?: Readonly<Record<string, UniformValue>>;
  /** Applied with `bind` before drawing (they persist). */
  textures?: Readonly<Record<string, TextureSource>>;
  /** Default "none" for passes, "add" for scatter. */
  blend?: BlendMode;
}

export interface ScatterRunOptions extends RunOptions {
  /** Particles to draw: gl_VertexID runs 0..count-1. */
  count: number;
  /** Point size in target texels (default 1), clamped to 1..GpuCompute.maxPointSize. */
  pointSize?: number;
}

export interface ScatterOptions {
  /** Shown in errors. */
  name?: string;
  /** Default fragment: "square" (default) adds `value` over the whole point, "soft" under a smooth disc. */
  shape?: "square" | "soft";
  /** A fragment body replacing the default: reads `in vec4 vValue` and gl_PointCoord, writes fragColor. */
  fragment?: string;
}

/** Shader compile/link failures (with the numbered source), unsupported formats and misuse. */
export class GpuError extends Error {}

/**
 * A grid size for an aspect (width / height) with `shortSide` texels on its shorter side, so
 * texels are square: gridSize(16 / 9, 128) is 228×128.
 */
export function gridSize(aspect: number, shortSide: number): { width: number; height: number } {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const short = Math.max(1, Math.round(shortSide));
  return ratio >= 1
    ? { width: Math.max(1, Math.round(short * ratio)), height: short }
    : { width: short, height: Math.max(1, Math.round(short / ratio)) };
}

// ---- internals shared by targets and programs ---------------------------------------------------

/** Anything GpuCompute.dispose frees (named apart from the global `Disposable` of `using`). */
interface Releasable {
  dispose(): void;
}

/** What targets and programs need from their GpuCompute. */
interface GpuContext {
  readonly gl: WebGL2RenderingContext;
  readonly floatLinear: boolean;
  readonly floatBlend: boolean;
  readonly maxPointSize: number;
  readonly maxTextureSize: number;
  readonly maxTextureUnits: number;
  /** Everything not yet disposed, freed by GpuCompute.dispose. */
  readonly live: Set<Releasable>;
  /** Scratch for clears. */
  readonly clearValue: Float32Array;
  /** Draw `source` stretched over a framebuffer (keeping content across a resize). */
  readonly blit: (source: WebGLTexture, framebuffer: WebGLFramebuffer, width: number, height: number) => void;
}

interface FormatSpec {
  readonly internal: number;
  readonly format: number;
  readonly type: number;
  readonly channels: number;
  /** Seeded from a Float32Array (else a Uint8Array). */
  readonly float: boolean;
}

function formatSpec(gl: WebGL2RenderingContext, format: TargetFormat): FormatSpec {
  switch (format) {
    case "r8":
      return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, channels: 1, float: false };
    case "rgba8":
      return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, channels: 4, float: false };
    case "r16f":
      return { internal: gl.R16F, format: gl.RED, type: gl.FLOAT, channels: 1, float: true };
    case "rg16f":
      return { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, channels: 2, float: true };
    case "rgba16f":
      return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT, channels: 4, float: true };
    case "r32f":
      return { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, channels: 1, float: true };
    case "rg32f":
      return { internal: gl.RG32F, format: gl.RG, type: gl.FLOAT, channels: 2, float: true };
    case "rgba32f":
      return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, channels: 4, float: true };
    default: {
      const unreachable: never = format;
      throw new GpuError(`unknown target format ${String(unreachable)}`);
    }
  }
}

function checkSize(context: GpuContext, width: number, height: number): void {
  const max = context.maxTextureSize;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > max || height > max) {
    throw new GpuError(`target size ${width}×${height} must be whole texels in 1..${max}`);
  }
}

function textureOf(source: TextureSource): WebGLTexture {
  if (source instanceof PingPong) return source.read.texture;
  if (source instanceof RenderTarget) return source.texture;
  return source;
}

/** The source with line numbers, lines named in the info log (`ERROR: 0:<line>:`) marked with >. */
function numbered(source: string, log: string): string {
  const flagged = new Set<number>();
  for (const match of log.matchAll(/ERROR: \d+:(\d+):/g)) flagged.add(Number(match[1]));
  return source
    .split("\n")
    .map((line, i) => `${flagged.has(i + 1) ? ">" : " "}${String(i + 1).padStart(4)}  ${line}`)
    .join("\n");
}

/** Names declared `uniform` anywhere in the source (including arrays and comma lists). */
function declaredUniforms(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+([^;{}]+);/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.replace(/\[.*$/, "").trim();
      if (name !== "") names.add(name);
    }
  }
  return names;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, name: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GpuError(`${name}: could not allocate a shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    const stage = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new GpuError(`${name}: ${stage} shader compile failed\n${log.trim()}\n${numbered(source, log)}`);
  }
  return shader;
}

/** Link a program from a shared vertex shader (kept) or vertex source (compiled and owned). */
function buildProgram(gl: WebGL2RenderingContext, vertex: WebGLShader | string, fragmentSource: string, name: string): WebGLProgram {
  const owned = typeof vertex === "string";
  const vertexShader = typeof vertex === "string" ? compileShader(gl, gl.VERTEX_SHADER, vertex, name) : vertex;
  let fragment: WebGLShader;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, name);
  } catch (error: unknown) {
    if (owned) gl.deleteShader(vertexShader);
    throw error;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // Only flagged while attached: freed together with the program. The shared vertex shader stays.
  gl.deleteShader(fragment);
  if (owned) gl.deleteShader(vertexShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    const listing = typeof vertex === "string"
      ? `vertex:\n${numbered(vertex, "")}\nfragment:\n${numbered(fragmentSource, "")}`
      : numbered(fragmentSource, "");
    throw new GpuError(`${name}: program link failed\n${log.trim()}\n${listing}`);
  }
  return program;
}

/** A uniform's upload: values per element, room for all of them and the call that sends them. */
interface UniformSlot {
  /** 1 for scalars, 2–4 for vectors, 4/9/16 for matrices. */
  readonly components: number;
  /** components × array length. */
  readonly capacity: number;
  readonly data: Float32Array | Int32Array | Uint32Array;
  readonly send: (count: number) => void;
}

function uniformSlot(gl: WebGL2RenderingContext, location: WebGLUniformLocation, type: number, size: number): UniformSlot | undefined {
  const floats = (components: number, send: (data: Float32Array, count: number) => void): UniformSlot => {
    const data = new Float32Array(components * size);
    return { components, capacity: data.length, data, send: (count) => send(data, count) };
  };
  const ints = (components: number, send: (data: Int32Array, count: number) => void): UniformSlot => {
    const data = new Int32Array(components * size);
    return { components, capacity: data.length, data, send: (count) => send(data, count) };
  };
  const uints = (components: number, send: (data: Uint32Array, count: number) => void): UniformSlot => {
    const data = new Uint32Array(components * size);
    return { components, capacity: data.length, data, send: (count) => send(data, count) };
  };
  switch (type) {
    case gl.FLOAT:
      return floats(1, (d, n) => gl.uniform1fv(location, d, 0, n));
    case gl.FLOAT_VEC2:
      return floats(2, (d, n) => gl.uniform2fv(location, d, 0, n));
    case gl.FLOAT_VEC3:
      return floats(3, (d, n) => gl.uniform3fv(location, d, 0, n));
    case gl.FLOAT_VEC4:
      return floats(4, (d, n) => gl.uniform4fv(location, d, 0, n));
    case gl.FLOAT_MAT2:
      return floats(4, (d, n) => gl.uniformMatrix2fv(location, false, d, 0, n));
    case gl.FLOAT_MAT3:
      return floats(9, (d, n) => gl.uniformMatrix3fv(location, false, d, 0, n));
    case gl.FLOAT_MAT4:
      return floats(16, (d, n) => gl.uniformMatrix4fv(location, false, d, 0, n));
    case gl.INT:
    case gl.BOOL:
      return ints(1, (d, n) => gl.uniform1iv(location, d, 0, n));
    case gl.INT_VEC2:
    case gl.BOOL_VEC2:
      return ints(2, (d, n) => gl.uniform2iv(location, d, 0, n));
    case gl.INT_VEC3:
    case gl.BOOL_VEC3:
      return ints(3, (d, n) => gl.uniform3iv(location, d, 0, n));
    case gl.INT_VEC4:
    case gl.BOOL_VEC4:
      return ints(4, (d, n) => gl.uniform4iv(location, d, 0, n));
    case gl.UNSIGNED_INT:
      return uints(1, (d, n) => gl.uniform1uiv(location, d, 0, n));
    case gl.UNSIGNED_INT_VEC2:
      return uints(2, (d, n) => gl.uniform2uiv(location, d, 0, n));
    case gl.UNSIGNED_INT_VEC3:
      return uints(3, (d, n) => gl.uniform3uiv(location, d, 0, n));
    case gl.UNSIGNED_INT_VEC4:
      return uints(4, (d, n) => gl.uniform4uiv(location, d, 0, n));
    default:
      return undefined;
  }
}

/** Whether the context can render to half-float textures at all (the extension can lie). */
function rendersHalfFloat(gl: WebGL2RenderingContext): boolean {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  return complete;
}

// ---- GLSL ---------------------------------------------------------------------------------------

const PRECISION = `precision highp float;
precision highp int;
precision highp sampler2D;
precision highp isampler2D;
precision highp usampler2D;`;

const PASS_VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // One triangle over the whole target: (0, 0), (2, 0), (0, 2) in uv.
  vUv = vec2(gl_VertexID == 1 ? 2.0 : 0.0, gl_VertexID == 2 ? 2.0 : 0.0);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const PASS_PREAMBLE = `#version 300 es
${PRECISION}
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uTexel;
uniform vec2 uSize;
`;

const BLIT_FRAGMENT = `${PASS_PREAMBLE}uniform sampler2D uSource;
void main() {
  fragColor = texture(uSource, vUv);
}
`;

const SCATTER_VERTEX_PREAMBLE = `#version 300 es
${PRECISION}
uniform vec2 uTexel;
uniform vec2 uSize;
uniform float uPointSize;
out vec4 vValue;
// This particle's point size in target texels: the run's pointSize unless particle() changes it.
float pointSize;
// The texel holding particle id in a state texture of the given size, row by row from the bottom.
ivec2 particleTexel(int id, ivec2 size) {
  return ivec2(id % size.x, id / size.x);
}
`;

const SCATTER_MAIN = `
void main() {
  pointSize = uPointSize;
  vec2 uv = vec2(0.0);
  vec4 value = vec4(0.0);
  bool live = particle(gl_VertexID, uv, value);
  vValue = value;
  // A skipped particle goes past the far plane, which clips points whatever their size.
  gl_Position = live ? vec4(uv * 2.0 - 1.0, 0.0, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
  gl_PointSize = pointSize;
}
`;

const SCATTER_FRAGMENT_PREAMBLE = `#version 300 es
${PRECISION}
in vec4 vValue;
out vec4 fragColor;
uniform vec2 uTexel;
uniform vec2 uSize;
`;

const SQUARE_POINT = `void main() {
  fragColor = vValue;
}
`;

const SOFT_POINT = `void main() {
  // A smooth disc filling the point: the value at its centre, nothing at its rim.
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float fall = max(0.0, 1.0 - dot(d, d));
  fragColor = vValue * fall * fall;
}
`;

// ---- render targets ----------------------------------------------------------------------------

/**
 * A texture with its framebuffer: a field passes write and sample. Made by `GpuCompute.target`.
 * `texture` changes identity when resized with `keep`, so read it when needed rather than holding it.
 */
export class RenderTarget implements Releasable {
  readonly format: TargetFormat;
  /** The filter in effect: "nearest" for a 32-bit format without OES_texture_float_linear. */
  readonly filter: TargetFilter;
  readonly wrap: TargetWrap;
  readonly #context: GpuContext;
  readonly #spec: FormatSpec;
  #texture: WebGLTexture;
  #framebuffer: WebGLFramebuffer;
  #width: number;
  #height: number;
  #disposed = false;

  constructor(context: GpuContext, options: TargetOptions) {
    this.#context = context;
    this.format = options.format;
    this.#spec = formatSpec(context.gl, options.format);
    // 32-bit floats filter linearly only with OES_texture_float_linear.
    const linear = options.filter !== "nearest" && (!options.format.endsWith("32f") || context.floatLinear);
    this.filter = linear ? "linear" : "nearest";
    this.wrap = options.wrap ?? "clamp";
    checkSize(context, options.width, options.height);
    this.#width = options.width;
    this.#height = options.height;
    const created = this.#create(options.width, options.height);
    this.#texture = created.texture;
    this.#framebuffer = created.framebuffer;
    context.live.add(this);
  }

  get texture(): WebGLTexture {
    this.#check();
    return this.#texture;
  }

  get framebuffer(): WebGLFramebuffer {
    this.#check();
    return this.#framebuffer;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /**
   * Change the size. Without `keep` the content is cleared to 0 (and the texture keeps its
   * identity); with it the old content is stretched over the new size through this target's
   * filter. Returns whether the size changed.
   */
  resize(width: number, height: number, keep = false): boolean {
    this.#check();
    if (width === this.#width && height === this.#height) return false;
    checkSize(this.#context, width, height);
    const gl = this.#context.gl;
    if (keep) {
      const next = this.#create(width, height);
      this.#context.blit(this.#texture, next.framebuffer, width, height);
      gl.deleteFramebuffer(this.#framebuffer);
      gl.deleteTexture(this.#texture);
      this.#texture = next.texture;
      this.#framebuffer = next.framebuffer;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.#texture);
      this.#allocate(width, height);
    }
    this.#width = width;
    this.#height = height;
    return true;
  }

  /** Fill every texel: one number for all channels, or up to four (missing ones 0). */
  clear(value: number | ArrayLike<number> = 0): void {
    this.#check();
    const gl = this.#context.gl;
    const v = this.#context.clearValue;
    for (let i = 0; i < 4; i++) v[i] = typeof value === "number" ? value : (value[i] ?? 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#framebuffer);
    gl.clearBufferfv(gl.COLOR, 0, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Upload the whole field, rows bottom to top, channels interleaved: a Float32Array of
   * width × height × channels for float formats, a Uint8Array for r8 / rgba8.
   */
  seed(data: Float32Array | Uint8Array): void {
    this.#check();
    const spec = this.#spec;
    const expected = this.#width * this.#height * spec.channels;
    if (data.length !== expected) throw new GpuError(`${this.format} seed has ${data.length} values, expected ${expected}`);
    if (spec.float !== data instanceof Float32Array) {
      throw new GpuError(`${this.format} seeds from a ${spec.float ? "Float32Array" : "Uint8Array"}`);
    }
    const gl = this.#context.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.#width, this.#height, spec.format, spec.type, data);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const gl = this.#context.gl;
    gl.deleteFramebuffer(this.#framebuffer);
    gl.deleteTexture(this.#texture);
    this.#context.live.delete(this);
  }

  #check(): void {
    if (this.#disposed) throw new GpuError(`a ${this.format} target was used after dispose`);
  }

  /** Allocate (zeroed) storage for the texture bound on the active unit. */
  #allocate(width: number, height: number): void {
    const gl = this.#context.gl;
    const spec = this.#spec;
    gl.texImage2D(gl.TEXTURE_2D, 0, spec.internal, width, height, 0, spec.format, spec.type, null);
  }

  #create(width: number, height: number): { texture: WebGLTexture; framebuffer: WebGLFramebuffer } {
    const gl = this.#context.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const filter = this.filter === "linear" ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    const repeatS = this.wrap === "repeat" || this.wrap === "repeat-x";
    const repeatT = this.wrap === "repeat" || this.wrap === "repeat-y";
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatS ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeatT ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    this.#allocate(width, height);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new GpuError(`a ${this.format} target of ${width}×${height} is not renderable here (status 0x${status.toString(16)})`);
    }
    return { texture, framebuffer };
  }
}

/**
 * Two same-sized targets for state updated in place: passes read `read` and write `write`, then
 * swap. Made by `GpuCompute.pingPong` (or from any two matching targets).
 */
export class PingPong {
  #read: RenderTarget;
  #write: RenderTarget;

  constructor(a: RenderTarget, b: RenderTarget) {
    if (a.width !== b.width || a.height !== b.height || a.format !== b.format) {
      throw new GpuError("a ping-pong pair needs two targets of the same size and format");
    }
    this.#read = a;
    this.#write = b;
  }

  /** The current state. */
  get read(): RenderTarget {
    return this.#read;
  }

  /** Scratch for the next state; its content is stale. */
  get write(): RenderTarget {
    return this.#write;
  }

  /** The current state's texture: what to hand the renderer (it changes on every swap). */
  get texture(): WebGLTexture {
    return this.#read.texture;
  }

  get width(): number {
    return this.#read.width;
  }

  get height(): number {
    return this.#read.height;
  }

  get format(): TargetFormat {
    return this.#read.format;
  }

  swap(): void {
    const read = this.#read;
    this.#read = this.#write;
    this.#write = read;
  }

  /** Resize both; `keep` stretches the current state over the new size. Returns whether it changed. */
  resize(width: number, height: number, keep = false): boolean {
    const changed = this.#read.resize(width, height, keep);
    this.#write.resize(width, height, false);
    return changed;
  }

  /** Fill both sides (see RenderTarget.clear). */
  clear(value: number | ArrayLike<number> = 0): void {
    this.#read.clear(value);
    this.#write.clear(value);
  }

  /** Upload the current state (see RenderTarget.seed). */
  seed(data: Float32Array | Uint8Array): void {
    this.#read.seed(data);
  }

  dispose(): void {
    this.#read.dispose();
    this.#write.dispose();
  }
}

// ---- programs ----------------------------------------------------------------------------------

interface SamplerSlot {
  readonly name: string;
  readonly unit: number;
  source: TextureSource | undefined;
}

/** A linked program with its uniforms and samplers listed: the common part of Pass and Scatter. */
abstract class GpuProgram implements Releasable {
  /** Shown in errors. */
  readonly name: string;
  readonly #context: GpuContext;
  readonly #program: WebGLProgram;
  readonly #uniforms = new Map<string, UniformSlot>();
  readonly #samplers: SamplerSlot[] = [];
  readonly #samplerByName = new Map<string, SamplerSlot>();
  readonly #declared: ReadonlySet<string>;
  readonly #texel: WebGLUniformLocation | null;
  readonly #size: WebGLUniformLocation | null;
  readonly #pointSize: WebGLUniformLocation | null;
  #disposed = false;

  protected constructor(context: GpuContext, name: string, vertex: WebGLShader | string, fragment: string) {
    this.name = name;
    this.#context = context;
    const gl = context.gl;
    const program = buildProgram(gl, vertex, fragment, name);
    this.#program = program;
    this.#declared = declaredUniforms(typeof vertex === "string" ? `${vertex}\n${fragment}` : fragment);
    try {
      gl.useProgram(program);
      const active: unknown = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      const total = typeof active === "number" ? active : 0;
      for (let i = 0; i < total; i++) {
        const info = gl.getActiveUniform(program, i);
        if (!info) continue;
        const uniform = info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name;
        const location = gl.getUniformLocation(program, uniform);
        // Built-ins (gl_DepthRange) and uniform-block members have no location of their own.
        if (location === null) continue;
        if (info.type === gl.SAMPLER_2D || info.type === gl.INT_SAMPLER_2D || info.type === gl.UNSIGNED_INT_SAMPLER_2D) {
          if (info.size !== 1) throw new GpuError(`${name}: sampler arrays are not supported (${uniform})`);
          const unit = this.#samplers.length;
          if (unit >= context.maxTextureUnits) {
            throw new GpuError(`${name}: more samplers than the ${context.maxTextureUnits} texture units`);
          }
          gl.uniform1i(location, unit);
          const slot: SamplerSlot = { name: uniform, unit, source: undefined };
          this.#samplers.push(slot);
          this.#samplerByName.set(uniform, slot);
          continue;
        }
        const slot = uniformSlot(gl, location, info.type, info.size);
        if (!slot) {
          const type = `0x${info.type.toString(16)}`;
          throw new GpuError(
            `${name}: uniform ${uniform} has a type this engine does not handle (${type}): ` +
              "use float, int, uint and bool scalars and vectors, square matrices and sampler2D",
          );
        }
        this.#uniforms.set(uniform, slot);
      }
    } catch (error: unknown) {
      gl.deleteProgram(program);
      throw error;
    }
    this.#texel = gl.getUniformLocation(program, "uTexel");
    this.#size = gl.getUniformLocation(program, "uSize");
    this.#pointSize = gl.getUniformLocation(program, "uPointSize");
    context.live.add(this);
  }

  /** Whether the source declares a uniform (or sampler) of this name, used or not. */
  declares(name: string): boolean {
    return this.#declared.has(name);
  }

  /**
   * Write uniforms now; they persist across runs. `strict` (default) throws on a name the source
   * never declares; without it such names are skipped (for routing one set over several programs).
   */
  set(values: Readonly<Record<string, UniformValue>>, strict = true): this {
    this.#check();
    this.#context.gl.useProgram(this.#program);
    for (const name in values) {
      const value = values[name];
      if (value === undefined) continue;
      const slot = this.#uniforms.get(name);
      if (slot !== undefined) {
        this.#write(name, slot, value);
        continue;
      }
      if (this.#samplerByName.has(name)) throw new GpuError(`${this.name}: ${name} is a sampler: give it in textures`);
      if (strict && !this.#declared.has(name)) throw new GpuError(`${this.name}: no uniform ${name} is declared`);
    }
    return this;
  }

  /** Remember the texture each sampler reads; they persist across runs. `strict` as for `set`. */
  bind(textures: Readonly<Record<string, TextureSource>>, strict = true): this {
    this.#check();
    for (const name in textures) {
      const source = textures[name];
      if (source === undefined) continue;
      const slot = this.#samplerByName.get(name);
      if (slot !== undefined) {
        slot.source = source;
        continue;
      }
      if (this.#uniforms.has(name)) throw new GpuError(`${this.name}: ${name} is not a sampler`);
      if (strict && !this.#declared.has(name)) throw new GpuError(`${this.name}: no sampler ${name} is declared`);
    }
    return this;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#context.gl.deleteProgram(this.#program);
    this.#context.live.delete(this);
  }

  /** Draw into `target`, honouring the GL state contract in the file header. */
  protected draw(target: RenderTarget, mode: "triangles" | "points", count: number, blend: BlendMode, pointSize: number): void {
    this.#check();
    const context = this.#context;
    const gl = context.gl;
    const into = target.texture;
    if (blend !== "none" && target.format.endsWith("32f") && !context.floatBlend) {
      throw new GpuError(`${this.name}: blending into a ${target.format} target needs EXT_float_blend; use a 16-bit target`);
    }
    gl.useProgram(this.#program);
    for (const slot of this.#samplers) {
      if (slot.source === undefined) throw new GpuError(`${this.name}: no texture bound to ${slot.name}`);
      const texture = textureOf(slot.source);
      if (texture === into) throw new GpuError(`${this.name}: ${slot.name} reads the target being drawn (use a PingPong)`);
      gl.activeTexture(gl.TEXTURE0 + slot.unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    if (this.#texel) gl.uniform2f(this.#texel, 1 / target.width, 1 / target.height);
    if (this.#size) gl.uniform2f(this.#size, target.width, target.height);
    if (this.#pointSize) gl.uniform1f(this.#pointSize, pointSize);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    switch (blend) {
      case "none":
        gl.disable(gl.BLEND);
        break;
      case "add":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case "max":
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        break;
      default: {
        const unreachable: never = blend;
        throw new GpuError(`${this.name}: unknown blend ${String(unreachable)}`);
      }
    }
    gl.drawArrays(mode === "points" ? gl.POINTS : gl.TRIANGLES, 0, count);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  #write(name: string, slot: UniformSlot, value: UniformValue): void {
    if (typeof value === "number" || typeof value === "boolean") {
      if (slot.components !== 1) throw new GpuError(`${this.name}: ${name} takes ${slot.components} values, got one`);
      slot.data[0] = Number(value);
      slot.send(1);
      return;
    }
    const count = Math.min(value.length, slot.capacity);
    if (count === 0 || count % slot.components !== 0) {
      throw new GpuError(`${this.name}: ${name} takes a multiple of ${slot.components} values, got ${value.length}`);
    }
    const data = slot.data;
    for (let i = 0; i < count; i++) data[i] = value[i] ?? 0;
    slot.send(count);
  }

  #check(): void {
    if (this.#disposed) throw new GpuError(`${this.name} was used after dispose`);
  }
}

/** A fullscreen fragment pass: one fragment per target texel. Made by `GpuCompute.pass`. */
export class Pass extends GpuProgram {
  constructor(context: GpuContext, vertex: WebGLShader, body: string, name: string) {
    super(context, name, vertex, PASS_PREAMBLE + body);
  }

  /**
   * Shade every texel of `target`. A PingPong target is drawn into its write side and swapped, so
   * its read side holds the result (blending into one is refused: the write side is stale).
   */
  run(target: RenderTarget | PingPong, options: RunOptions = {}): void {
    if (options.uniforms) this.set(options.uniforms);
    if (options.textures) this.bind(options.textures);
    const blend = options.blend ?? "none";
    if (target instanceof PingPong) {
      if (blend !== "none") {
        throw new GpuError(`${this.name}: blending into a PingPong would land on its stale write side; draw into its read target`);
      }
      this.draw(target.write, "triangles", 3, blend, 1);
      target.swap();
      return;
    }
    this.draw(target, "triangles", 3, blend, 1);
  }
}

/** Particles drawn as points, read from state textures by gl_VertexID. Made by `GpuCompute.scatter`. */
export class Scatter extends GpuProgram {
  readonly #maxPointSize: number;

  constructor(context: GpuContext, body: string, options: ScatterOptions) {
    const fragment = SCATTER_FRAGMENT_PREAMBLE + (options.fragment ?? (options.shape === "soft" ? SOFT_POINT : SQUARE_POINT));
    super(context, options.name ?? "scatter", SCATTER_VERTEX_PREAMBLE + body + SCATTER_MAIN, fragment);
    this.#maxPointSize = context.maxPointSize;
  }

  /** Draw `count` particles into `target` (a PingPong: into its read side, the current state). */
  run(target: RenderTarget | PingPong, options: ScatterRunOptions): void {
    if (options.uniforms) this.set(options.uniforms);
    if (options.textures) this.bind(options.textures);
    const count = options.count;
    if (!Number.isInteger(count) || count < 0) throw new GpuError(`${this.name}: count must be a whole number ≥ 0, got ${count}`);
    if (count === 0) return;
    const size = Math.min(Math.max(options.pointSize ?? 1, 1), this.#maxPointSize);
    this.draw(target instanceof PingPong ? target.read : target, "points", count, options.blend ?? "add", size);
  }
}

// ---- the engine --------------------------------------------------------------------------------

/**
 * The factory for targets and programs on one WebGL2 context; `dispose` frees everything it made.
 * Create with `GpuCompute.create(gl)`, undefined where float render targets are unsupported.
 */
export class GpuCompute {
  readonly gl: WebGL2RenderingContext;
  /** 32-bit float targets filter linearly (OES_texture_float_linear). */
  readonly floatLinear: boolean;
  /** 32-bit float targets can be blended into (EXT_float_blend). */
  readonly floatBlend: boolean;
  /** Largest point size a scatter can draw, in texels. */
  readonly maxPointSize: number;
  readonly #context: GpuContext;
  /** The fullscreen-triangle vertex shader every pass shares. */
  readonly #vertex: WebGLShader;
  readonly #blit: WebGLProgram;
  #disposed = false;

  /** The engine, or undefined when the context cannot render to float textures. */
  static create(gl: WebGL2RenderingContext): GpuCompute | undefined {
    if (gl.getExtension("EXT_color_buffer_float") === null) return undefined;
    if (!rendersHalfFloat(gl)) return undefined;
    const floatLinear = gl.getExtension("OES_texture_float_linear") !== null;
    const floatBlend = gl.getExtension("EXT_float_blend") !== null;
    return new GpuCompute(gl, floatLinear, floatBlend);
  }

  private constructor(gl: WebGL2RenderingContext, floatLinear: boolean, floatBlend: boolean) {
    this.gl = gl;
    this.floatLinear = floatLinear;
    this.floatBlend = floatBlend;
    const points: unknown = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    this.maxPointSize = points instanceof Float32Array ? Math.max(1, points[1] ?? 1) : 1;
    const textureSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const units: unknown = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    this.#vertex = compileShader(gl, gl.VERTEX_SHADER, PASS_VERTEX, "gpu pass vertex");
    this.#blit = buildProgram(gl, this.#vertex, BLIT_FRAGMENT, "gpu blit");
    gl.useProgram(this.#blit);
    gl.uniform1i(gl.getUniformLocation(this.#blit, "uSource"), 0);
    this.#context = {
      gl,
      floatLinear,
      floatBlend,
      maxPointSize: this.maxPointSize,
      maxTextureSize: typeof textureSize === "number" ? textureSize : 4096,
      maxTextureUnits: typeof units === "number" ? units : 16,
      live: new Set(),
      clearValue: new Float32Array(4),
      blit: (source, framebuffer, width, height) => this.#blitInto(source, framebuffer, width, height),
    };
  }

  /** A render target, zeroed. */
  target(options: TargetOptions): RenderTarget {
    this.#check();
    return new RenderTarget(this.#context, options);
  }

  /** Two render targets as a ping-pong pair, zeroed. */
  pingPong(options: TargetOptions): PingPong {
    this.#check();
    return new PingPong(new RenderTarget(this.#context, options), new RenderTarget(this.#context, options));
  }

  /** A fullscreen pass from a fragment body (see the file header for its preamble). */
  pass(body: string, name = "pass"): Pass {
    this.#check();
    return new Pass(this.#context, this.#vertex, body, name);
  }

  /** A particle scatter from a vertex body defining `particle()` (see the file header). */
  scatter(body: string, options: ScatterOptions = {}): Scatter {
    this.#check();
    return new Scatter(this.#context, body, options);
  }

  /** Free every target and program made by this engine, then the engine. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const item of [...this.#context.live]) item.dispose();
    this.gl.deleteProgram(this.#blit);
    this.gl.deleteShader(this.#vertex);
  }

  #check(): void {
    if (this.#disposed) throw new GpuError("the GPU engine was used after dispose");
  }

  #blitInto(source: WebGLTexture, framebuffer: WebGLFramebuffer, width: number, height: number): void {
    const gl = this.gl;
    gl.useProgram(this.#blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
