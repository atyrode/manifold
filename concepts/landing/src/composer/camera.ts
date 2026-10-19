// The interior's live camera (ADR 0062 "The camera", D18): a pose about the variant's rest rig
// (`RIG_*`, compiled in), x, y and z offsets in metres in the room's frame (x right, y up, z ahead),
// a yaw (radians, turning left), a pitch (radians, looking down) and a focal (a factor of the rest
// focal). A link carries it in one packed key, CAMERA_KEY (`encodeCamera`), read as `elements=` is:
// without the key a scene stands at its rest pose. The shader takes it as uCamera (2 vec4, outside
// uParams: `cameraUniforms`).
//
// Each layer declares the poses it can be drawn through (`CameraRange`, `layerPoseRange`): a layer
// drawn from the ray its spans (absent: any), a layer painted on the frame a `tolerance` about the
// rest pose, which it takes as parallax (room.ts: `x.p` is the cell pulled back through the pose to
// the seat's plane). The room's shell, drawn in metres, moves within the room (`shellPoseRange`). The
// pose is held to the intersection of the ranges of the shell and every layer on (`meetRanges`,
// `clampPose`); a guest whose range excludes the pose is refused (place.ts), and the camera stays.
import type { CameraRange, Rig, Room, Span } from "./types.ts";

/** A pose about the rest rig: offsets (m, rad) and the focal's factor (1 at rest). */
export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly focal: number;
}

export type PoseAxis = keyof CameraPose;

/** The axes in the packed key's order. */
export const POSE_AXES: readonly PoseAxis[] = ["x", "y", "z", "yaw", "pitch", "focal"];

/** The rest pose: the rig as compiled. */
export const REST_POSE: CameraPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, focal: 1 };

/** The rest pose as a range: what the home layers' ranges must all hold. */
export const AT_REST: PoseRange = {
  x: [0, 0],
  y: [0, 0],
  z: [0, 0],
  yaw: [0, 0],
  pitch: [0, 0],
  focal: [1, 1],
};

/** The URL key holding a room's camera pose. */
export const CAMERA_KEY = "cam";

/** The poses something can be drawn through: a span per axis, about the rest pose. */
export type PoseRange = Readonly<Record<PoseAxis, Span>>;

/** Half widths about the rest pose, per axis (focal: of its factor); an axis left out is held. */
export type PoseTolerance = Partial<Readonly<Record<PoseAxis, number>>>;

/**
 * The tolerance of a layer painted on its frame: about as far as the pointer's parallax already
 * moves the sill's view (0.03 × 0.012 screen heights), a few centimetres and a degree.
 */
export const PAINTED: PoseTolerance = {
  x: 0.03,
  y: 0.02,
  z: 0.05,
  yaw: 0.02,
  pitch: 0.015,
  focal: 0.03,
};

const ANY: Span = [-Infinity, Infinity];

/** Whether a pose is the rest pose. */
export function atRest(pose: CameraPose): boolean {
  return POSE_AXES.every((axis) => pose[axis] === REST_POSE[axis]);
}

/**
 * The poses a layer can be drawn through over `rig`: its tolerance about the rest pose where it is
 * painted on its frame; else its spans (eye, x, z, turn, pitch, focal: the rig's frame, metres and
 * radians) as offsets from the rig, any where it gives none.
 */
export function layerPoseRange(camera: CameraRange, rig: Rig): PoseRange {
  const tolerance = camera.tolerance;
  if (tolerance !== undefined) {
    const about = (axis: PoseAxis): Span => {
      const t = tolerance[axis] ?? 0;
      return [REST_POSE[axis] - t, REST_POSE[axis] + t];
    };
    return {
      x: about("x"),
      y: about("y"),
      z: about("z"),
      yaw: about("yaw"),
      pitch: about("pitch"),
      focal: about("focal"),
    };
  }
  const less = (span: Span | undefined, rest: number): Span =>
    span === undefined ? ANY : [span[0] - rest, span[1] - rest];
  return {
    x: camera.x ?? ANY,
    y: less(camera.eye, rig.eye),
    z: camera.z ?? ANY,
    yaw: less(camera.turn, rig.turn),
    pitch: less(camera.pitch, rig.pitch),
    focal:
      camera.focal === undefined
        ? [0, Infinity]
        : [camera.focal[0] / rig.focal, camera.focal[1] / rig.focal],
  };
}

/**
 * The poses the room's shell (composer/shell.ts, drawn in metres) holds: within about a third of
 * the way to its back wall across, up and back, the eye over the ledge's top and short of the
 * ledge's front edge, turned and pitched a few degrees, zoomed a third either way.
 */
export function shellPoseRange(rig: Rig, room: Room): PoseRange {
  const reach = 0.3 * room.back;
  const front = Math.min(room.ledge?.front ?? room.distance, room.distance);
  return {
    x: [-reach, reach],
    y: [Math.min(0, 0.05 - rig.eye), reach],
    z: [-reach, 0.5 * front],
    yaw: [-0.35, 0.35],
    pitch: [-0.3, 0.3],
    focal: [0.75, 1.35],
  };
}

/** The intersection of `ranges`; undefined where two do not meet. */
export function meetRanges(ranges: readonly PoseRange[]): PoseRange | undefined {
  const meet = (axis: PoseAxis): Span =>
    ranges.reduce<Span>((a, r) => [Math.max(a[0], r[axis][0]), Math.min(a[1], r[axis][1])], ANY);
  const out: PoseRange = {
    x: meet("x"),
    y: meet("y"),
    z: meet("z"),
    yaw: meet("yaw"),
    pitch: meet("pitch"),
    focal: meet("focal"),
  };
  return POSE_AXES.every((axis) => out[axis][0] <= out[axis][1] + 1e-9) ? out : undefined;
}

/** The first axis in which `ranges` do not meet, or undefined where they do. */
export function disjointAxis(ranges: readonly PoseRange[]): PoseAxis | undefined {
  return POSE_AXES.find(
    (axis) =>
      Math.max(...ranges.map((r) => r[axis][0])) >
      Math.min(...ranges.map((r) => r[axis][1])) + 1e-9,
  );
}

/** The first axis of `pose` outside `range`, or undefined when it lies within. */
export function outside(pose: CameraPose, range: PoseRange): PoseAxis | undefined {
  return POSE_AXES.find(
    (axis) => pose[axis] < range[axis][0] - 1e-9 || pose[axis] > range[axis][1] + 1e-9,
  );
}

const UNITS: Readonly<Record<PoseAxis, (v: number) => string>> = {
  x: (v) => `${v.toFixed(2)} m`,
  y: (v) => `${v.toFixed(2)} m`,
  z: (v) => `${v.toFixed(2)} m`,
  yaw: (v) => `${((v * 180) / Math.PI).toFixed(1)}°`,
  pitch: (v) => `${((v * 180) / Math.PI).toFixed(1)}°`,
  focal: (v) => `×${v.toFixed(2)}`,
};

/** Why a pose lies outside a range, at `axis`: "the camera's x at 0.20 m, past 0.03 m". */
export function outsideReason(pose: CameraPose, range: PoseRange, axis: PoseAxis): string {
  const [lo, hi] = range[axis];
  const value = pose[axis];
  const bound = value < lo ? lo : hi;
  return `the camera's ${axis} at ${UNITS[axis](value)} lies past ${UNITS[axis](bound)}, the most it is drawn at`;
}

/** The pose's packed grid: thousandths of a metre, a radian and the focal's factor. */
const GRID = 1000;

/**
 * `pose` held within `range` (which holds the rest pose), on the packed key's grid so a link reads
 * back as itself: each axis clamped, then rounded to the grid and stepped back inside if that took
 * it past its bound.
 */
export function clampPose(pose: CameraPose, range: PoseRange): CameraPose {
  const held = (axis: PoseAxis): number => {
    const [lo, hi] = range[axis];
    const v = Math.min(Math.max(pose[axis], lo), hi);
    let s = Math.round(v * GRID) / GRID;
    if (s > hi + 1e-9) s = Math.round((s - 1 / GRID) * GRID) / GRID;
    if (s < lo - 1e-9) s = Math.round((s + 1 / GRID) * GRID) / GRID;
    return s;
  };
  return {
    x: held("x"),
    y: held("y"),
    z: held("z"),
    yaw: held("yaw"),
    pitch: held("pitch"),
    focal: held("focal"),
  };
}

/** The pose as uCamera takes it: (x, y, z, focal), (yaw, pitch, 0, 0). */
export function cameraUniforms(pose: CameraPose): Float32Array {
  return Float32Array.of(pose.x, pose.y, pose.z, pose.focal, pose.yaw, pose.pitch, 0, 0);
}

// ---- the URL --------------------------------------------------------------------------------------

/** The packed form's mark: its first number. */
const FORMAT = 1;

const zigzag = (n: number): number => (n >= 0 ? 2 * n : -2 * n - 1);
const unzigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/**
 * The pose as CAMERA_KEY's value: base64url varints, the mark then each axis's offset from rest in
 * thousandths (millimetres, milliradians, the focal factor's thousandths). "" at rest.
 */
export function encodeCamera(pose: CameraPose): string {
  if (atRest(pose)) return "";
  const bytes: number[] = [];
  const push = (value: number) => {
    let v = value;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 0x80);
    }
    bytes.push(v);
  };
  push(FORMAT);
  for (const axis of POSE_AXES) push(zigzag(Math.round((pose[axis] - REST_POSE[axis]) * GRID)));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** CAMERA_KEY's value read back; the rest pose for "" or anything malformed. */
export function decodeCamera(text: string): CameraPose {
  if (text === "" || !/^[A-Za-z0-9_-]+$/.test(text)) return REST_POSE;
  let binary: string;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return REST_POSE;
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
  if (next() !== FORMAT) return REST_POSE;
  const values: number[] = [];
  for (const axis of POSE_AXES) {
    const v = next();
    if (v === undefined) return REST_POSE;
    values.push(REST_POSE[axis] + unzigzag(v) / GRID);
  }
  if (at !== bytes.length) return REST_POSE;
  const [x = 0, y = 0, z = 0, yaw = 0, pitch = 0, focal = 1] = values;
  return { x, y, z, yaw, pitch, focal };
}
