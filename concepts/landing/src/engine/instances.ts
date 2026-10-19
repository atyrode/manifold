// The instance texture (RGBA32F, the canvas scene's sim slot 0): the camera and every placed object
// of the document, so moving, turning, scaling or tuning anything uploads data and builds nothing.
//
//   row 0, the header:   texel 0  eye.xyz, tan(fov / 2)
//                        texel 1  forward.xyz        texel 2  right.xyz        texel 3  up.xyz
//                        texel 3 + r  x: how many objects kind row r holds (r = 1..kinds)
//   row r, kind r - 1 of the registry (src/engine/kinds/index.ts: the layout is the same for every
//   document, so a program still building draws the new data as far as it can), instance i from
//   texel i * stride:    texel 0  at.xyz, scale
//                        texel 1  bounds min.xyz, cos(yaw)
//                        texel 2  bounds max.xyz, sin(yaw)
//                        texel 3  x: its index in the document's objects, then its options in the
//                                 kind's order, four a texel (option k: component 1 + k from texel 3)
import { cameraBasis } from "./camera.ts";
import { kindById, kindRow, kinds, optionValues } from "./kinds/index.ts";
import type { EngineDoc, KindDef } from "./types.ts";

/** The most instances of one kind a program draws: its largest bucket. */
export const MAX_INSTANCES = 32;
/** The instance buckets a program is sized by (src/engine/program.ts). */
export const BUCKETS = [1, 2, 4, 8, 16, 32] as const;
/** The header's texels before the counts. */
const HEADER = 3;
/** The texels of an instance before its options' (the first holds its index). */
const TRANSFORM = 3;

/** Texels an instance of `kind` takes: its transform, bounds, index and options. */
export function instanceStride(kind: KindDef): number {
  return TRANSFORM + Math.ceil((1 + kind.options.length) / 4);
}

/** Where option `k` of an instance lies: its texel past the instance's first, and its component. */
export function optionTexel(k: number): readonly [texel: number, component: number] {
  return [TRANSFORM + ((1 + k) >> 2), (1 + k) & 3];
}

/** The texture's size: wide enough for the header and every kind's largest bucket. */
export const INSTANCE_WIDTH = Math.max(
  HEADER + 1 + kinds.length,
  ...kinds.map((kind) => instanceStride(kind) * MAX_INSTANCES),
);
export const INSTANCE_HEIGHT = 1 + kinds.length;

/**
 * `doc` packed as the texture holds it, into `into` (INSTANCE_WIDTH x INSTANCE_HEIGHT RGBA). Throws
 * for an object of an unknown kind or past MAX_INSTANCES of its kind.
 */
export function packInstances(
  doc: EngineDoc,
  into: Float32Array = new Float32Array(INSTANCE_WIDTH * INSTANCE_HEIGHT * 4),
): Float32Array {
  into.fill(0);
  const { forward, right, up, tan } = cameraBasis(doc.camera);
  into.set([...doc.camera.at, tan, ...forward, 0, ...right, 0, ...up, 0], 0);
  const counts = new Array<number>(kinds.length + 1).fill(0);
  doc.objects.forEach((placed, index) => {
    const kind = kindById(placed.kind);
    if (kind === undefined) throw new RangeError(`engine: no kind "${placed.kind}"`);
    const row = kindRow(kind);
    const i = counts[row] ?? 0;
    if (i >= MAX_INSTANCES)
      throw new RangeError(`engine: more than ${MAX_INSTANCES} objects of kind ${kind.id}`);
    counts[row] = i + 1;
    const options = optionValues(kind, placed);
    const bounds = kind.bounds(options);
    const at = (row * INSTANCE_WIDTH + i * instanceStride(kind)) * 4;
    into.set(
      [
        ...placed.at,
        placed.scale,
        ...bounds.min,
        Math.cos(placed.yaw),
        ...bounds.max,
        Math.sin(placed.yaw),
        index,
        ...kind.options.map((def) => options[def.key] ?? 0),
      ],
      at,
    );
  });
  for (let row = 1; row <= kinds.length; row++) into[(HEADER + row) * 4] = counts[row] ?? 0;
  return into;
}

/** An RGBA32F texture of this size, read texel by texel (texelFetch), its storage fixed. */
export function floatTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
  return texture;
}

/** The texture on the GPU, uploaded only when the document it was last packed from changes. */
export class InstanceTexture {
  readonly #gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly #data = new Float32Array(INSTANCE_WIDTH * INSTANCE_HEIGHT * 4);
  #doc: EngineDoc | undefined;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.texture = floatTexture(gl, INSTANCE_WIDTH, INSTANCE_HEIGHT);
  }

  /** Show `doc`: packed and uploaded if it is not the document uploaded last. */
  show(doc: EngineDoc): void {
    if (doc === this.#doc) return;
    this.#doc = doc;
    packInstances(doc, this.#data);
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      INSTANCE_WIDTH,
      INSTANCE_HEIGHT,
      gl.RGBA,
      gl.FLOAT,
      this.#data,
    );
  }

  dispose(): void {
    this.#gl.deleteTexture(this.texture);
  }
}
