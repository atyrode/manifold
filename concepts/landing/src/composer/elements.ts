// Light elements (ADR 0062 "Light elements", D17): placed lights, a window, a lamp, a candle, a
// neon tube or a fire, `at` in metres in the frame of the eye-level composer's rig (x across from
// the centre line, y up from the floor, a room's ledge top, z ahead of the eye). Their kinds and
// how many there are are compiled in (`elementFeatures`: adding one builds a program, as a layer
// turn does; none compiles nothing in); where each stands, its colour, power, reach and flicker
// are uniforms (`elementUniforms`, uElements), so moving one builds nothing. A link carries the
// list in one key, ELEMENTS_KEY, packed (`encodeElements`), read as `planets=` is: without the key
// a scene holds its variant's elements, `elements=` holds none. A room's shell draws and lights
// them (composer/shell.ts), the outdoor composer's program outdoors (composer/glsl.ts), which holds
// no window and no shadowing element (LAND_HOLDS).
import type { ElementKind, LightElement, ScenePreset, WindowWall } from "./types.ts";

export class ElementError extends Error {}

/** The URL key holding a scene's elements. */
export const ELEMENTS_KEY = "elements";

/**
 * The most lights a program sums (`localLight`): its layers' declared lights and its elements. A
 * point light (lamp, candle, neon, fire) with its body costs about 31 M SwiftShader instructions a
 * 320×200 draw on the sill (8 candles: +249 M, 10% of its default's 2,374 M; ADR 0062 D17).
 */
export const LIGHT_CAP = 8;

/**
 * The most windows among them: a window's light (the sky through it, the sun's and the moon's
 * patches, the key's shadows, the fill it gives back) costs about as much as 9 point lights (a
 * second window on the sill: +285 M), so two windows and six point lights stay within 18% of the
 * sill's default.
 */
export const WINDOW_CAP = 2;

/**
 * The most elements that throw shadows (`roomCaster` toward them), the World's key aside; on the
 * sill one costs no more than the measurement's noise (about 10 M a draw) over the same light.
 */
export const SHADOW_CAP = 1;

/** What a composer's programs hold of the elements beside LIGHT_CAP lights. */
export interface ElementHolds {
  readonly windows: number;
  readonly shadows: number;
}

/** A room's: WINDOW_CAP windows, SHADOW_CAP shadowing elements. */
export const ROOM_HOLDS: ElementHolds = { windows: WINDOW_CAP, shadows: SHADOW_CAP };

/**
 * The land's: no window (it lets the World into a room; outdoors the World is all round) and no
 * shadowing element (no caster is drawn toward an element outdoors).
 */
export const LAND_HOLDS: ElementHolds = { windows: 0, shadows: 0 };

/** What a link's list may keep (`fitElements`): `cap` lights beside the layers', and the holds. */
export interface ElementRoom extends ElementHolds {
  readonly cap: number;
}

/** uElements rows an element takes: (at, power), (colour, reach), (flicker, seed, size), (bars, sash). */
export const ELEMENT_ROWS = 4;

/** The kinds a program draws, as compiled in (ROOM_KIND_<k>); a window's code is its wall's. */
const KIND_CODES: Readonly<Record<Exclude<ElementKind, "window">, number>> = {
  lamp: 1,
  candle: 2,
  neon: 3,
  fire: 4,
  screen: 5,
};
const WALL_CODES: Readonly<Record<WindowWall, number>> = { back: 8, left: 9, right: 10, front: 11 };

/** An element's kind as compiled in. */
export function kindCode(element: LightElement): number {
  if (element.kind !== "window") return KIND_CODES[element.kind];
  if (element.window === undefined) throw new ElementError("a window element needs its frame");
  return WALL_CODES[element.window.wall];
}

/**
 * The compile-time features of a scene's elements: how many (ROOM_ELEMENTS), and each one's kind
 * (ROOM_KIND_<k>); none for none, so a scene without elements compiles nothing in (a room's shell
 * reads a missing count as 0).
 */
export function elementFeatures(elements: readonly LightElement[]): Record<string, number> {
  if (elements.length === 0) return {};
  const out: Record<string, number> = { ROOM_ELEMENTS: elements.length };
  elements.forEach((element, k) => (out[`ROOM_KIND_${k}`] = kindCode(element)));
  return out;
}

/** The elements' kinds as `features` compile them in (`elementFeatures`), in order. */
export function elementKinds(features: Readonly<Record<string, number>>): number[] {
  return Array.from(
    { length: features["ROOM_ELEMENTS"] ?? 0 },
    (_, k) => features[`ROOM_KIND_${k}`] ?? 0,
  );
}

/** Whether a room lists the World: a window layer looks out of it, or a window element lets it in. */
export function roomListsWorld(
  preset: ScenePreset,
  layers: readonly { readonly window?: boolean }[],
): boolean {
  return (
    layers.some((layer) => layer.window === true) ||
    (preset.elements ?? []).some((element) => element.kind === "window")
  );
}

/** The elements as uElements rows (ELEMENT_ROWS each, LIGHT_CAP elements). */
export function elementUniforms(elements: readonly LightElement[]): Float32Array {
  const data = new Float32Array(LIGHT_CAP * ELEMENT_ROWS * 4);
  elements.slice(0, LIGHT_CAP).forEach((e, k) => {
    const w = e.window;
    data.set(
      [
        ...e.at,
        e.power,
        ...e.colour,
        e.reach,
        e.flicker,
        k * 7.31 + 1.7,
        w?.size[0] ?? 0,
        w?.size[1] ?? 0,
        w?.bars[0] ?? 0,
        w?.bars[1] ?? 0,
        w?.sash ?? 0,
        e.shadow ? 1 : 0,
      ],
      k * ELEMENT_ROWS * 4,
    );
  });
  return data;
}

/**
 * Refuses a list a program cannot hold: more lights than LIGHT_CAP beside `layerLights` the layers
 * declare, more windows or shadowing elements than its composer `holds` (a room: WINDOW_CAP and
 * SHADOW_CAP; outdoors none), a `screen` (reserved, not drawn yet).
 */
export function checkElements(
  elements: readonly LightElement[],
  layerLights: number,
  holds: ElementHolds,
): void {
  if (elements.length + layerLights > LIGHT_CAP)
    throw new ElementError(
      `${elements.length} elements and ${layerLights} layer lights, at most ${LIGHT_CAP} lights a program`,
    );
  const windows = elements.filter((e) => e.kind === "window").length;
  if (windows > holds.windows)
    throw new ElementError(
      holds.windows === 0
        ? "a window element outdoors: it lets the World into a room, and outdoors the World is all round"
        : `${windows} windows, at most ${holds.windows} a program`,
    );
  const shadows = elements.filter((e) => e.shadow && e.kind !== "window").length;
  if (shadows > holds.shadows)
    throw new ElementError(
      holds.shadows === 0
        ? "a shadowing element outdoors: no caster is drawn toward one there"
        : `${shadows} shadowing elements, at most ${holds.shadows}`,
    );
  if (elements.some((e) => e.kind === "screen"))
    throw new ElementError("a screen element is reserved, not drawn yet (D23)");
}

/**
 * The first of `elements` a program holds, in order: at most `room.cap` of them (LIGHT_CAP less the
 * layers' lights), each window and shadowing element past what its composer holds and each screen
 * left out.
 */
export function fitElements(elements: readonly LightElement[], room: ElementRoom): LightElement[] {
  const out: LightElement[] = [];
  let windows = 0;
  let shadows = 0;
  for (const e of elements) {
    if (out.length >= room.cap || e.kind === "screen") continue;
    if (e.kind === "window" && windows >= room.windows) continue;
    if (e.kind !== "window" && e.shadow && shadows >= room.shadows) continue;
    if (e.kind === "window") windows += 1;
    else if (e.shadow) shadows += 1;
    out.push(e);
  }
  return out;
}

// ---- the URL --------------------------------------------------------------------------------------

/** The packed form's mark: the first number of every list. */
const FORMAT = 1;
const KINDS: readonly ElementKind[] = ["window", "lamp", "candle", "neon", "fire", "screen"];
const WALLS: readonly WindowWall[] = ["back", "left", "right", "front"];

const zigzag = (n: number): number => (n >= 0 ? 2 * n : -2 * n - 1);
const unzigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
const cm = (metres: number): number => zigzag(Math.round(metres * 100));
const hundredths = (value: number): number => zigzag(Math.round(value * 100));

function pushVarint(bytes: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 0x80);
  }
  bytes.push(v);
}

/**
 * The list as ELEMENTS_KEY's value: base64url varints, centimetres and hundredths, so an element
 * round-trips to those grids. "" for none.
 */
export function encodeElements(elements: readonly LightElement[]): string {
  if (elements.length === 0) return "";
  const bytes: number[] = [];
  pushVarint(bytes, FORMAT);
  pushVarint(bytes, elements.length);
  for (const e of elements) {
    pushVarint(bytes, KINDS.indexOf(e.kind));
    for (const v of e.at) pushVarint(bytes, cm(v));
    for (const v of e.colour) pushVarint(bytes, hundredths(v));
    pushVarint(bytes, hundredths(e.power));
    pushVarint(bytes, cm(e.reach));
    pushVarint(bytes, hundredths(e.flicker));
    pushVarint(bytes, e.shadow ? 1 : 0);
    if (e.window !== undefined) {
      pushVarint(bytes, WALLS.indexOf(e.window.wall));
      for (const v of e.window.size) pushVarint(bytes, cm(v));
      for (const v of e.window.bars) pushVarint(bytes, v);
      pushVarint(bytes, cm(e.window.sash ?? 0));
    }
  }
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** ELEMENTS_KEY's value read back; none for "" or anything malformed. */
export function decodeElements(text: string): LightElement[] {
  if (text === "" || !/^[A-Za-z0-9_-]+$/.test(text)) return [];
  let binary: string;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return [];
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let at = 0;
  const next = (): number | undefined => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = bytes[at++];
      if (byte === undefined) return undefined;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return undefined;
  };
  const read = (n: number, scale: (v: number) => number): number[] | undefined => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = next();
      if (v === undefined) return undefined;
      out.push(scale(v));
    }
    return out;
  };
  const metres = (v: number) => unzigzag(v) / 100;
  if (next() !== FORMAT) return [];
  const count = next();
  // A list longer than a program holds still reads; readElements keeps the first that fit.
  if (count === undefined) return [];
  const out: LightElement[] = [];
  for (let n = 0; n < count; n++) {
    const kind = KINDS[next() ?? -1];
    const xyz = read(3, metres);
    const rgb = read(3, metres);
    const rest = read(3, metres);
    const shadow = next();
    if (kind === undefined || xyz === undefined || rgb === undefined || rest === undefined)
      return [];
    if (shadow === undefined) return [];
    const [x = 0, y = 0, z = 0] = xyz;
    const [r = 0, g = 0, b = 0] = rgb;
    const [power = 0, reach = 0, flicker = 0] = rest;
    const element: LightElement = {
      kind,
      at: [x, y, z],
      colour: [r, g, b],
      power,
      reach,
      flicker,
      shadow: shadow === 1,
    };
    if (kind !== "window") {
      out.push(element);
      continue;
    }
    const wall = WALLS[next() ?? -1];
    const size = read(2, metres);
    const bars = read(2, (v) => v);
    const sash = next();
    if (wall === undefined || size === undefined || bars === undefined || sash === undefined)
      return [];
    const [w = 0, h = 0] = size;
    const [cols = 0, rows = 0] = bars;
    const s = metres(sash);
    out.push({
      ...element,
      window: { wall, size: [w, h], bars: [cols, rows], ...(s === 0 ? {} : { sash: s }) },
    });
  }
  return out;
}
