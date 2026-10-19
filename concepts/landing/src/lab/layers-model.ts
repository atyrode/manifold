// The Layers section's rules, apart from its DOM (layers.ts): a composed scene's layer switches
// (SceneDef.layers, src/composer/compose.ts) as a row per role, each layer's chip on, off or refused
// with the placer's reason, and what a click on a chip changes. A role holding one layer at most
// swaps: switching a backdrop, a bed, a ground or a water on switches off the one of its role, and
// the backdrop or bed on stays on (a stack has exactly one; another swaps it). Switching a layer on
// switches off the layers it excludes, or that exclude it (README "Relations between layers"). A
// layer that needs a host is left refused until its host is on: the chip says which.
import type { CameraPose } from "../composer/camera.ts";
import type { SceneLayers } from "../composer/compose.ts";
import { ROLES, type Role } from "../composer/types.ts";

/** How a role's row is headed. */
export const ROLE_LABEL: Record<Role, string> = {
  backdrop: "Backdrop",
  bed: "Bed",
  ground: "Ground",
  water: "Water",
  dressing: "Dressings",
  cover: "Covers",
  life: "Life",
  chore: "Chores",
};

/** The roles a stack holds at most one of: a second swaps for the first. */
const SWAPS: Partial<Record<Role, true>> = { backdrop: true, bed: true, ground: true, water: true };

/** The roles a stack always holds one of: the one on stays on. */
const KEPT: Partial<Record<Role, true>> = { backdrop: true, bed: true };

/** A layer's chip: drawn, switched off, or switched on and not drawn, for `reason`. */
export type LayerState =
  | { readonly kind: "on" }
  | { readonly kind: "off" }
  | { readonly kind: "refused"; readonly reason: string };

/** A role's row: its layers offered by the preset's rig, in canonical order, each with its state. */
export interface LayerRow {
  readonly role: Role;
  readonly layers: readonly { readonly id: string; readonly state: LayerState }[];
}

/**
 * The Layers section's rows, in role order: every role holding an offered layer, with the layer
 * switches as `value` reads them (a URL key's value, its default filled in), placed at a room's
 * camera `pose` (a guest out of its range refused).
 */
export function layerRows(
  layers: SceneLayers,
  value: (key: string) => number,
  pose?: CameraPose,
): LayerRow[] {
  const placement = layers.place(
    Object.fromEntries(layers.offered.map((layer) => [layer.id, value(layer.id)])),
    pose,
  );
  const drawn = new Set(placement.layers.map((placed) => placed.layer.id));
  const reasons = new Map(placement.refused.map((refusal) => [refusal.layer, refusal.reason]));
  return ROLES.flatMap((role) => {
    const offered = layers.offered.filter((layer) => layer.role === role);
    if (offered.length === 0) return [];
    return [
      {
        role,
        layers: offered.map(({ id }) => {
          const reason = reasons.get(id);
          const state: LayerState = drawn.has(id)
            ? { kind: "on" }
            : reason !== undefined
              ? { kind: "refused", reason }
              : { kind: "off" };
          return { id, state };
        }),
      },
    ];
  });
}

/**
 * What switching layer `id` `on` changes (URL keys to values; empty: nothing, as for the backdrop
 * on switched off): the layer, the other layer of its role where its role holds one, and on
 * switching on, the layers on that it excludes or that exclude it.
 */
export function layerTurn(
  layers: SceneLayers,
  value: (key: string) => number,
  id: string,
  on: boolean,
): Record<string, number> {
  const layer = layers.offered.find((offer) => offer.id === id);
  if (layer === undefined) return {};
  const others = layers.offered.filter((other) => other.id !== id && value(other.id) > 0.5);
  if (!on)
    return KEPT[layer.role] === true && !others.some((other) => other.role === layer.role)
      ? {}
      : { [id]: 0 };
  const patch: Record<string, number> = { [id]: 1 };
  for (const other of others)
    if (SWAPS[layer.role] === true && other.role === layer.role) patch[other.id] = 0;
  const excluded = new Set((layers.excludes[id] ?? []).map((rule) => rule.layer));
  for (const other of others) if (excluded.has(other.id)) patch[other.id] = 0;
  return patch;
}

/**
 * A composed scene's own groups in the Controls order: the groups of no layer as they come, then
 * each layer's (`layerOf`: Blurb.layer) in role order, a role's layers in canonical order (README
 * "Layers in the lab").
 */
export function layerGroupOrder(
  groups: readonly string[],
  layerOf: (group: string) => string | undefined,
  layers: SceneLayers,
): string[] {
  const rank = (group: string) => {
    const at = layers.offered.findIndex((layer) => layer.id === layerOf(group));
    const layer = layers.offered[at];
    return layer === undefined ? -1 : ROLES.indexOf(layer.role) * layers.offered.length + at;
  };
  return groups
    .map((group, index) => ({ group, index, rank: rank(group) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.group);
}
