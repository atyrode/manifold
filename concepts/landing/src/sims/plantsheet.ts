// The plant component's sheet tier: RootedPlants drawn on the GPU into an RGBA8 sheet, for a scene
// with hundreds of organs where walking them per fragment would cost too much (the pond's border).
// Each frame the organs are drawn in the scene's order (back to front) as instanced quads: a rigid
// organ is a sprite cut from an atlas the scene paints once (botany's leaves and flowers, see
// decor.ts), a flexible one a tapering stroke along its arc in a few segments; upright organs are
// not drawn. Later organs cover earlier ones, as a painter's would, and the sheet is mipmapped so a
// scene can blur it for shadows. Plain RGBA8 targets: no float extension is needed.
//
// Sheet texel (rows bottom to top; the sheet's top row is uv.y = 1, as a canvas uploaded flipped):
//   r  1 where an organ covers it, else 0 (its mipmaps: coverage, blurred)
//   g  lightness 0..1: the sprite's own shading scaled by the organ's shade, or the stroke's shade
//   b  (material × 16 + layer × 4 + 2) / 255: the family's material code where the sprite has none
//   a  (128 + 127 × phenology) / 255: 128 green (see plantSheetGlsl)
//
// Coordinates: sheet pixels, x right and y down (a canvas's), scene units times `view.scale`; organ
// angles turn x toward y. A sprite family's `box` is the rectangle of the sprite's own frame (stalk at
// the origin, tip toward +x, one unit = the organ's length; y down) that its atlas cells hold.
//
// Detail: a sprite's coverage comes from the atlas mip that matches its size on the sheet (holes and
// teeth finer than a sheet texel fade into the silhouette), its shading from the nearest full-size
// texel. Tier 1 organs (sims/plants.ts) draw a rounder silhouette in one shade; tier 0 ones nothing.
//
// GL state: as GpuCompute's (gpu.ts): returns with the framebuffer unbound and blending off; leaves
// the viewport, program, active unit and the textures on units 0 and 1 changed; draws with whatever
// vertex array is bound, without attributes.
//
// Usage:
//   const sheet = new PlantSheet(gl);
//   sheet.draw(plants, order, families, atlas, { width: 2048, height: 1152, scale: 1152 });
//   return [sheet.texture];
import type { RootedPlants } from "./plants.ts";
import { PlantHabit } from "./plants.ts";

/** One family of sprites in the atlas: a material, its cells (texture uv rectangles) and their frame. */
export interface PlantSheetFamily {
  /** Material code where a sprite texel carries none. */
  readonly material: number;
  /** Atlas uv rectangles (u0, v0 at the box's x0, y0 corner; u1, v1 at x1, y1), one per variant. */
  readonly cells: readonly (readonly [number, number, number, number])[];
  /** The sprite frame each cell holds: x0, y0, x1, y1 in organ lengths. */
  readonly box: readonly [number, number, number, number];
}

/** The sheet's size in pixels and the pixels per scene unit. */
export interface PlantSheetView {
  width: number;
  height: number;
  scale: number;
}

export class PlantSheetError extends Error {}

/** Primitives the prims texture holds a row of; 4 texels each. */
const ROW = 512;
/** Most segments a flexible organ's stroke is cut into. */
const SEGMENTS = 16;
/** Sheet pixels a stroke segment spans at most along a curved organ. */
const SEGMENT_PX = 14;
/** Lightness a sprite's atlas is painted at; an organ's shade scales it. */
export const PLANT_ATLAS_SHADE = 0.5;

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uPrims;
uniform vec2 uSheet;
out vec2 vAt;
flat out vec4 vT0;
flat out vec4 vT1;
flat out vec4 vT2;
flat out vec4 vT3;
void main() {
  int w = textureSize(uPrims, 0).x;
  ivec2 c = ivec2(gl_InstanceID % w, 4 * (gl_InstanceID / w));
  vec4 t0 = texelFetch(uPrims, c, 0);
  vec4 t1 = texelFetch(uPrims, c + ivec2(0, 1), 0);
  vec4 t2 = texelFetch(uPrims, c + ivec2(0, 2), 0);
  vec4 t3 = texelFetch(uPrims, c + ivec2(0, 3), 0);
  int v = gl_VertexID;
  vec2 corner = vec2(v == 1 || v == 4 || v == 5 ? 1.0 : 0.0, v == 2 || v == 3 || v == 5 ? 1.0 : 0.0);
  vec2 world;
  if (t3.x < 3.5) {
    // A sprite: the box's corner in the organ's frame, mirrored, scaled and turned onto the sheet.
    vec2 local = mix(t1.xy, t1.zw, corner);
    vec2 l = vec2(local.x, mod(t3.x, 2.0) > 0.5 ? -local.y : local.y) * t0.w;
    vec2 d = vec2(cos(t0.z), sin(t0.z));
    world = t0.xy + vec2(d.x * l.x - d.y * l.y, d.y * l.x + d.x * l.y);
    vAt = local;
  } else {
    // A stroke: a capsule's bounding quad from a to b.
    float r = max(t1.x, t1.y) + 1.0;
    vec2 ab = t0.zw - t0.xy;
    float len = length(ab);
    vec2 dir = len > 1e-4 ? ab / len : vec2(1.0, 0.0);
    world = t0.xy + dir * mix(-r, len + r, corner.x) + vec2(-dir.y, dir.x) * mix(-r, r, corner.y);
    vAt = world;
  }
  vT0 = t0;
  vT1 = t1;
  vT2 = t2;
  vT3 = t3;
  gl_Position = vec4(world.x / uSheet.x * 2.0 - 1.0, 1.0 - world.y / uSheet.y * 2.0, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uAtlas;
in vec2 vAt;
flat in vec4 vT0;
flat in vec4 vT1;
flat in vec4 vT2;
flat in vec4 vT3;
out vec4 fragColor;
const float ATLAS_SHADE = ${PLANT_ATLAS_SHADE.toFixed(3)};
void main() {
  float material = vT3.y;
  float layer = floor(vT3.z);
  float shade = fract(vT3.z) * 1.001;
  float pheno = vT3.w;
  if (vT3.x < 3.5) {
    vec2 f = (vAt - vT1.xy) / (vT1.zw - vT1.xy);
    vec2 uv = mix(vT2.xy, vT2.zw, f);
    bool simple = vT3.x > 1.5;
    // Coverage at the mip matching the sprite's size on the sheet (rounder still in the simple tier).
    float cover = texture(uAtlas, uv, simple ? 1.5 : 0.0).r;
    if (cover < 0.5) discard;
    vec4 texel = texelFetch(uAtlas, clamp(ivec2(uv * vec2(textureSize(uAtlas, 0))), ivec2(0), textureSize(uAtlas, 0) - 1), 0);
    if (!simple && texel.r > 0.5) {
      material = floor(texel.b * 255.0 / 16.0 + 0.01);
      shade = texel.g * shade / ATLAS_SHADE;
    }
  } else {
    vec2 ab = vT0.zw - vT0.xy;
    float t = clamp(dot(vAt - vT0.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    if (length(vAt - vT0.xy - ab * t) > mix(vT1.x, vT1.y, t)) discard;
  }
  fragColor = vec4(1.0, clamp(shade, 0.0, 1.0), (material * 16.0 + layer * 4.0 + 2.0) / 255.0, (128.0 + 127.0 * clamp(pheno, -1.0, 1.0)) / 255.0);
}
`;

/**
 * GLSL decoding a sheet texel (texelFetch it: codes must never be interpolated):
 * `float plantSheetMaterial(vec4 t)`, `float plantSheetLayer(vec4 t)`, `float plantSheetPheno(vec4 t)`
 * (exactly 0 for green). Coverage is t.r, lightness t.g.
 */
export const plantSheetGlsl = `
// A plant sheet texel (sims/plantsheet.ts): material and layer from b, phenology from a.
float plantSheetMaterial(vec4 t) {
  return floor(floor(t.b * 255.0 + 0.5) / 16.0);
}
float plantSheetLayer(vec4 t) {
  return floor(mod(floor(t.b * 255.0 + 0.5), 16.0) / 4.0);
}
float plantSheetPheno(vec4 t) {
  return (floor(t.a * 255.0 + 0.5) - 128.0) / 127.0;
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new PlantSheetError("plant sheet: shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new PlantSheetError(
      `plant sheet: ${type === gl.VERTEX_SHADER ? "vertex" : "fragment"} shader failed: ${log}`,
    );
  }
  return shader;
}

/** RootedPlants rasterised into a mipmapped RGBA8 sheet (see the header). */
export class PlantSheet {
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #prims: WebGLTexture;
  readonly #sheet: WebGLTexture;
  readonly #framebuffer: WebGLFramebuffer;
  readonly #sheetSize: WebGLUniformLocation | null;
  #data = new Float32Array(ROW * 4 * 4);
  #rows = 0;
  #width = 0;
  #height = 0;
  /** Primitives drawn by the last `draw`. */
  count = 0;
  readonly #at = new Float64Array(3);
  readonly #to = new Float64Array(3);

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new PlantSheetError(`plant sheet: link failed: ${gl.getProgramInfoLog(program) ?? ""}`);
    this.#program = program;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uPrims"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uAtlas"), 1);
    this.#sheetSize = gl.getUniformLocation(program, "uSheet");
    this.#prims = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#prims);
    for (const name of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, name, gl.NEAREST);
    this.#sheet = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#sheet);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#framebuffer = gl.createFramebuffer();
  }

  /** The sheet as last drawn. */
  get texture(): WebGLTexture {
    return this.#sheet;
  }

  /**
   * Draws `plants` into the sheet, organ `order[0]` first (the back); `families[form]` is the sprite
   * family of rigid organs of that form; `atlas` holds their cells, mipmapped.
   */
  draw(
    plants: RootedPlants,
    order: Int32Array,
    families: readonly (PlantSheetFamily | undefined)[],
    atlas: WebGLTexture,
    view: PlantSheetView,
  ): void {
    const gl = this.#gl;
    const count = this.#pack(plants, order, families, view.scale);
    this.count = count;
    if (view.width !== this.#width || view.height !== this.#height) {
      this.#width = view.width;
      this.#height = view.height;
      gl.bindTexture(gl.TEXTURE_2D, this.#sheet);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        view.width,
        view.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#sheet, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new PlantSheetError(
          `plant sheet: a ${view.width}×${view.height} sheet is not renderable here (status 0x${status.toString(16)})`,
        );
      }
    }
    const rows = Math.max(1, Math.ceil(count / ROW)) * 4;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#prims);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (rows !== this.#rows) {
      this.#rows = rows;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        ROW,
        rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        this.#data.subarray(0, ROW * rows * 4),
      );
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        ROW,
        rows,
        gl.RGBA,
        gl.FLOAT,
        this.#data.subarray(0, ROW * rows * 4),
      );
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#framebuffer);
    gl.viewport(0, 0, view.width, view.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count > 0) {
      gl.useProgram(this.#program);
      gl.uniform2f(this.#sheetSize, view.width, view.height);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#sheet);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  dispose(): void {
    const gl = this.#gl;
    gl.deleteProgram(this.#program);
    gl.deleteTexture(this.#prims);
    gl.deleteTexture(this.#sheet);
    gl.deleteFramebuffer(this.#framebuffer);
  }

  /** Writes the primitives, back to front; returns how many. */
  #pack(
    plants: RootedPlants,
    order: Int32Array,
    families: readonly (PlantSheetFamily | undefined)[],
    scale: number,
  ): number {
    let n = 0;
    const at = this.#at;
    const to = this.#to;
    for (let k = 0; k < order.length; k++) {
      const i = order[k] ?? 0;
      const tier = plants.tier[i] ?? 0;
      const habit = plants.habit[i] ?? 0;
      if (tier <= 0 || i >= plants.count || habit === PlantHabit.upright) continue;
      const layer = plants.layer[i] ?? 0;
      const shade = Math.min(plants.shade[i] ?? 0.5, 0.999);
      const pheno = plants.pheno[i] ?? 0;
      const length = (plants.grown[i] ?? 0) * scale;
      if (habit === PlantHabit.rigid) {
        const family = families[plants.form[i] ?? 0];
        if (!family || family.cells.length === 0) continue;
        const cell =
          family.cells[((plants.variant[i] ?? 0) + (plants.cycle[i] ?? 0)) % family.cells.length];
        if (!cell) continue;
        const data = this.#reserve(n);
        const t = (n % ROW) * 4 + Math.floor(n / ROW) * ROW * 16;
        data[t] = (plants.x[i] ?? 0) * scale;
        data[t + 1] = (plants.y[i] ?? 0) * scale;
        data[t + 2] = plants.angle[i] ?? 0;
        data[t + 3] = length;
        const t1 = t + ROW * 4;
        data.set(family.box, t1);
        data.set(cell, t1 + ROW * 4);
        const t3 = t1 + ROW * 8;
        data[t3] = ((plants.side[i] ?? 1) < 0 ? 1 : 0) + (tier < 2 ? 2 : 0);
        data[t3 + 1] = family.material;
        data[t3 + 2] = layer + shade;
        data[t3 + 3] = pheno;
        n++;
        continue;
      }
      // A flexible organ: a stroke tapering from `width` to `width × a` (a = 0: no taper), cut into
      // segments short enough to follow its arc.
      const width = (plants.width[i] ?? 0) * (plants.size[i] ?? 0) * scale;
      if (width <= 0) continue;
      const end = (plants.a[i] ?? 0) > 0 ? (plants.a[i] ?? 1) : 1;
      const turn = Math.abs(plants.turn[i] ?? 0);
      const segments =
        turn < 0.05
          ? 1
          : Math.min(SEGMENTS, Math.max(1, Math.ceil(length / SEGMENT_PX), Math.ceil(turn / 0.25)));
      plants.pointAt(i, 0, at);
      for (let s = 1; s <= segments; s++) {
        plants.pointAt(i, s / segments, to);
        const data = this.#reserve(n);
        const t = (n % ROW) * 4 + Math.floor(n / ROW) * ROW * 16;
        data[t] = (at[0] ?? 0) * scale;
        data[t + 1] = (at[1] ?? 0) * scale;
        data[t + 2] = (to[0] ?? 0) * scale;
        data[t + 3] = (to[1] ?? 0) * scale;
        const t1 = t + ROW * 4;
        const taper = tier < 2 ? 1 : end;
        data[t1] = 0.5 * Math.max(width * (1 + (taper - 1) * ((s - 1) / segments)), 1);
        data[t1 + 1] = 0.5 * Math.max(width * (1 + (taper - 1) * (s / segments)), 1);
        data[t1 + 2] = 0;
        data[t1 + 3] = 0;
        const t3 = t1 + ROW * 8;
        data[t3] = 4;
        data[t3 + 1] = plants.form[i] ?? 0;
        data[t3 + 2] = layer + shade;
        data[t3 + 3] = pheno;
        at[0] = to[0] ?? 0;
        at[1] = to[1] ?? 0;
        n++;
      }
    }
    return n;
  }

  /** The prims data with room for primitive n (grown a row of ROW at a time). */
  #reserve(n: number): Float32Array {
    const needed = (Math.floor(n / ROW) + 1) * ROW * 16;
    if (this.#data.length < needed) {
      const grown = new Float32Array(needed);
      grown.set(this.#data);
      this.#data = grown;
    }
    return this.#data;
  }
}
