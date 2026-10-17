// Which layers a setup draws and where they stand (README "Space", ADR "Foreground conflicts"): a
// pure function of the preset (its rig and home layers) and the layers switched on, never the
// window's aspect or another knob, so a program's placement is a constant of the program.
//
// Layers are taken in order: the preset's home layers, then the guests, each group in canonical
// order (the composer's registry order). Each one is kept unless
//   - its role holds one and has it already (a second backdrop or ground), or a layer kept before
//     excludes it or it excludes one, or its host (`requires`) is not kept;
//   - COMPOSER_CAPS.layers are kept already, or it is a subject and the front band holds
//     COMPOSER_CAPS.subjects of them;
//   - none of its anchors fits: each in turn, the first whose exclusive and clearing claims overlap
//     none of those placed, and whose `mustShow` claims lie in the rig's view at its minAspect;
//   - its claims would take the program past COMPOSER_CAPS.claims.
// A layer dropped is refused with a reason naming what holds its place. A later layer never moves an
// earlier one. A preset always has a backdrop: with none switched on, its home backdrop stands.
import { COMPOSER_CAPS } from "./caps.ts";
import { overlaps, placeClaim } from "./claims.ts";
import type { Anchor, LayerDef, PlacedClaim, Rig, ScenePreset, Span } from "./types.ts";

export interface PlacedLayer {
  readonly layer: LayerDef;
  readonly anchor: Anchor;
}

/** Why a layer switched on is not drawn. */
export interface Refusal {
  readonly layer: string;
  readonly reason: string;
}

export interface Placement {
  /** Kept, in canonical order. */
  readonly layers: readonly PlacedLayer[];
  /** Their claims where they stand, in canonical order. */
  readonly claims: readonly PlacedClaim[];
  readonly refused: readonly Refusal[];
}

const within = (value: number, span: Span | undefined): boolean =>
  span === undefined || (value >= span[0] - 1e-9 && value <= span[1] + 1e-9);

/** Whether the layer can be drawn through the rig (its `camera` range admits it): offered at all. */
export function admits(layer: LayerDef, rig: Rig): boolean {
  const camera = layer.camera;
  return (
    within(rig.eye, camera.eye) &&
    within(rig.horizon, camera.horizon) &&
    within(rig.focal, camera.focal) &&
    within(rig.pitch, camera.pitch)
  );
}

/** The roles a stack holds at most one of. */
const SINGLE: Readonly<Partial<Record<string, true>>> = { backdrop: true, ground: true };

/** Where a layer with no anchors of its own stands: the rig's own origin. */
const ORIGIN: Anchor = { name: "here", at: [0, 0] };

/**
 * Place `on` (layer ids switched on) over `offered` (the composer's layers the rig admits, canonical
 * order) for `preset`: see the header.
 */
export function place(
  offered: readonly LayerDef[],
  preset: Pick<ScenePreset, "rig" | "layers">,
  on: ReadonlySet<string>,
): Placement {
  const home = new Set(preset.layers);
  const backdropOn = offered.some((layer) => layer.role === "backdrop" && on.has(layer.id));
  const forced = backdropOn
    ? undefined
    : offered.find((layer) => layer.role === "backdrop" && home.has(layer.id));
  const wanted = offered.filter((layer) => on.has(layer.id) || layer === forced);
  const order = [
    ...wanted.filter((layer) => home.has(layer.id)),
    ...wanted.filter((layer) => !home.has(layer.id)),
  ];
  const kept: PlacedLayer[] = [];
  const claims: PlacedClaim[] = [];
  const refused: Refusal[] = [];

  for (const layer of order) {
    const refuse = (reason: string) => refused.push({ layer: layer.id, reason });
    const same =
      SINGLE[layer.role] === true
        ? kept.find((placed) => placed.layer.role === layer.role)
        : undefined;
    if (same) {
      refuse(`${same.layer.title} is the ${layer.role} already: one at a time`);
      continue;
    }
    const exclusion = kept.flatMap((placed) => {
      const rule =
        placed.layer.excludes?.find((r) => r.layer === layer.id) ??
        layer.excludes?.find((r) => r.layer === placed.layer.id);
      return rule === undefined ? [] : [{ title: placed.layer.title, why: rule.why }];
    })[0];
    if (exclusion) {
      refuse(`not with ${exclusion.title}: ${exclusion.why}`);
      continue;
    }
    const missing = layer.requires?.find(
      (host) => !kept.some((placed) => placed.layer.id === host),
    );
    if (missing !== undefined) {
      refuse(`needs ${offered.find((other) => other.id === missing)?.title ?? missing}`);
      continue;
    }
    if (kept.length >= COMPOSER_CAPS.layers) {
      refuse(`${COMPOSER_CAPS.layers} layers are on: the most a stack holds`);
      continue;
    }
    const front = (candidate: LayerDef) =>
      candidate.subject === true && candidate.bands.includes("front");
    if (
      front(layer) &&
      kept.filter((placed) => front(placed.layer)).length >= COMPOSER_CAPS.subjects
    ) {
      refuse(`the front holds ${COMPOSER_CAPS.subjects} subjects already`);
      continue;
    }
    let blocker: PlacedClaim | undefined;
    let fit: { anchor: Anchor; claims: PlacedClaim[] } | undefined;
    for (const anchor of layer.space.anchors.length > 0 ? layer.space.anchors : [ORIGIN]) {
      const mine = layer.space.claims.map((claim) => placeClaim(claim, layer.id, anchor.at));
      const hidden = mine.some((claim) => claim.mustShow === true && !shows(preset.rig, claim));
      const clash = mine
        .filter((claim) => claim.kind !== "shared")
        .flatMap((claim) =>
          claims.filter((other) => other.kind !== "shared" && overlaps(claim.shape, other.shape)),
        )[0];
      if (!hidden && clash === undefined) {
        fit = { anchor, claims: mine };
        break;
      }
      blocker ??= clash;
    }
    if (fit === undefined) {
      refuse(
        blocker === undefined
          ? `no room in view for ${layer.title.toLowerCase()}`
          : `${blocker.name} stand where ${layer.title.toLowerCase()} would`,
      );
      continue;
    }
    if (claims.length + fit.claims.length > COMPOSER_CAPS.claims) {
      refuse(`its claims would take the stack past ${COMPOSER_CAPS.claims}`);
      continue;
    }
    kept.push({ layer, anchor: fit.anchor });
    claims.push(...fit.claims);
  }
  kept.sort((a, b) => offered.indexOf(a.layer) - offered.indexOf(b.layer));
  const rank = new Map(kept.map((placed, i) => [placed.layer.id, i]));
  claims.sort((a, b) => (rank.get(a.layer) ?? 0) - (rank.get(b.layer) ?? 0));
  return { layers: kept, claims, refused };
}

/** Whether floor point (x, z) is in the rig's view at its minAspect: in front, inside the frame's sides. */
function inView(rig: Rig, x: number, z: number): boolean {
  return z > 0 && Math.abs(x) * rig.focal <= 0.5 * rig.minAspect * z;
}

/** Whether the claim's outline shows at the rig's minAspect (its extreme points). */
function shows(rig: Rig, claim: PlacedClaim): boolean {
  const shape = claim.shape;
  switch (shape.kind) {
    case "disc": {
      const [x, z] = shape.at;
      return (
        inView(rig, x - shape.r, z) && inView(rig, x + shape.r, z) && inView(rig, x, z - shape.r)
      );
    }
    case "box":
      return [-1, 1].every((sx) =>
        [-1, 1].every((sz) =>
          inView(rig, shape.at[0] + sx * shape.half[0], shape.at[1] + sz * shape.half[1]),
        ),
      );
    case "strip":
      return shape.points.every(([x, z]) => inView(rig, x, z));
    default: {
      const unreachable: never = shape;
      throw new Error(`composer: unknown shape ${String(unreachable)}`);
    }
  }
}
