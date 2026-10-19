// The document as the lab's canvas mode edits it (src/engine/types.ts EngineDoc): every edit makes
// a new document and leaves the objects it does not touch as they were, the same objects; ids stay
// unique and stable. Also what the palette offers (kinds by family, a refused one with its reason)
// and how the outliner names an object.
import { readKnobs, type ParamDef } from "../params.ts";
import type {
  EngineCamera,
  EngineDoc,
  Family,
  KindDef,
  Placed,
  Refusal,
  Vec3,
} from "../engine/types.ts";
import { objectToWorld, wrapAngle } from "./canvas-camera.ts";
import type { IconName } from "./icons.ts";

/** An object's scale stays within these (its kind's natural size at 1). */
export const SCALE_RANGE = { min: 0.05, max: 50 } as const;

/** The palette's families, in its order, with their headings and icons. */
export const FAMILIES: readonly {
  readonly id: Family;
  readonly title: string;
  readonly icon: IconName;
}[] = [
  { id: "ground", title: "Ground", icon: "mountain" },
  { id: "water", title: "Water", icon: "waves" },
  { id: "structure", title: "Structures", icon: "house" },
  { id: "furniture", title: "Furniture", icon: "cup" },
  { id: "plant", title: "Plants", icon: "tree" },
  { id: "creature", title: "Creatures", icon: "bird" },
  { id: "light", title: "Lights", icon: "bulb" },
  { id: "prop", title: "Props", icon: "stone" },
  { id: "phenomenon", title: "Phenomena", icon: "sparkle" },
];

/** A refusal that is one (Refusal less its "can" case). */
export type Refused = NonNullable<Refusal>;

/**
 * Why `doc` cannot hold another `kind`, or undefined if it can: one of its exclusive group already
 * stands in it (one ground), or it holds `max` of it already.
 */
export function kindRefusal(doc: EngineDoc, kind: KindDef, kinds: readonly KindDef[]): Refusal {
  if (kind.exclusive !== undefined) {
    const holder = doc.objects
      .map((object) => kinds.find((candidate) => candidate.id === object.kind))
      .find((candidate) => candidate?.exclusive === kind.exclusive);
    if (holder)
      return {
        kind: kind.id,
        why:
          holder.id === kind.id
            ? `The document has its ${kind.title.toLowerCase()} already: one ${kind.exclusive} only.`
            : `The document has a ${holder.title.toLowerCase()} already: one ${kind.exclusive} only.`,
      };
  }
  const count = doc.objects.filter((object) => object.kind === kind.id).length;
  if (count >= kind.max)
    return {
      kind: kind.id,
      why:
        kind.max === 1
          ? `At most one ${kind.title.toLowerCase()} in a document.`
          : `At most ${kind.max} of ${kind.title.toLowerCase()} in a document.`,
    };
  return undefined;
}

/** An id for a new object of `kind` that no object of `doc` has: the kind's id and a number. */
export function freshId(doc: EngineDoc, kind: string): string {
  const taken = new Set(doc.objects.map((object) => object.id));
  for (let n = 1; ; n++) if (!taken.has(`${kind}-${n}`)) return `${kind}-${n}`;
}

/** A turn facing the eye: the object's forward (+z) toward a camera at yaw `cameraYaw`. */
export function facing(cameraYaw: number): number {
  return wrapAngle(cameraYaw + Math.PI);
}

/**
 * `doc` with a new object of `kind` standing at `at`, turned `yaw`, at its natural size and default
 * options, and its id; or why the document cannot hold it.
 */
export function addObject(
  doc: EngineDoc,
  kind: KindDef,
  kinds: readonly KindDef[],
  at: Vec3,
  yaw: number,
): { readonly doc: EngineDoc; readonly id: string } | Refused {
  const refusal = kindRefusal(doc, kind, kinds);
  if (refusal) return refusal;
  const id = freshId(doc, kind.id);
  const placed: Placed = { id, kind: kind.id, at, yaw: wrapAngle(yaw), scale: 1, options: {} };
  return { doc: { ...doc, objects: [...doc.objects, placed] }, id };
}

/** `doc` with object `id` changed by `change`; `doc` itself when it holds no such object. */
function update(doc: EngineDoc, id: string, change: (placed: Placed) => Placed): EngineDoc {
  const at = doc.objects.findIndex((object) => object.id === id);
  const placed = doc.objects[at];
  if (!placed) return doc;
  const objects = [...doc.objects];
  objects[at] = change(placed);
  return { ...doc, objects };
}

export function moveObject(doc: EngineDoc, id: string, at: Vec3): EngineDoc {
  return update(doc, id, (placed) => ({ ...placed, at }));
}

export function turnObject(doc: EngineDoc, id: string, yaw: number): EngineDoc {
  return update(doc, id, (placed) => ({ ...placed, yaw: wrapAngle(yaw) }));
}

export function scaleObject(doc: EngineDoc, id: string, scale: number): EngineDoc {
  const clamped = Math.min(SCALE_RANGE.max, Math.max(SCALE_RANGE.min, scale));
  return update(doc, id, (placed) => ({ ...placed, scale: clamped }));
}

export function setOptions(
  doc: EngineDoc,
  id: string,
  options: Readonly<Record<string, number>>,
): EngineDoc {
  return update(doc, id, (placed) => ({ ...placed, options }));
}

export function removeObject(doc: EngineDoc, id: string): EngineDoc {
  const objects = doc.objects.filter((object) => object.id !== id);
  return objects.length === doc.objects.length ? doc : { ...doc, objects };
}

/**
 * `doc` with a copy of object `id` (its options, turn and size) standing beside it, a width and a
 * quarter of its bounds to its right, and the copy's id; or why the document cannot hold another of
 * its kind. Undefined when `doc` holds no such object or its kind is unknown.
 */
export function duplicateObject(
  doc: EngineDoc,
  id: string,
  kinds: readonly KindDef[],
): { readonly doc: EngineDoc; readonly id: string } | Refused | undefined {
  const placed = doc.objects.find((object) => object.id === id);
  const kind = placed && kinds.find((candidate) => candidate.id === placed.kind);
  if (!placed || !kind) return undefined;
  const refusal = kindRefusal(doc, kind, kinds);
  if (refusal) return refusal;
  const bounds = kind.bounds(placed.options);
  const width = Math.max(bounds.max[0] - bounds.min[0], 0.2);
  const copy: Placed = {
    ...placed,
    id: freshId(doc, kind.id),
    at: objectToWorld(placed, [width * 1.25, 0, 0]),
  };
  const at = doc.objects.indexOf(placed);
  const objects = [...doc.objects.slice(0, at + 1), copy, ...doc.objects.slice(at + 1)];
  return { doc: { ...doc, objects }, id: copy.id };
}

export function setCamera(doc: EngineDoc, camera: EngineCamera): EngineDoc {
  return { ...doc, camera };
}

export function setWorld(doc: EngineDoc, world: Readonly<Record<string, number>>): EngineDoc {
  return { ...doc, world };
}

/**
 * Knob values as a document keeps them (an object's options, the World's knobs): `values` with
 * `patch` over them, each read as the lab reads a knob (clamped into its bounds, a switch 0 or 1,
 * a choice one of its options: params.ts readKnobs), keeping only what differs from its default, so
 * a missing key reads its default. Keys no knob of `defs` has are dropped.
 */
export function knobValues(
  defs: readonly ParamDef[],
  values: Readonly<Record<string, number>>,
  patch: Readonly<Record<string, string | number>>,
): Record<string, number> {
  const merged: Record<string, string | number> = { ...values, ...patch };
  const read = readKnobs(defs, (key) => (key in merged ? String(merged[key]) : null));
  const defaults = readKnobs(defs, () => null);
  return Object.fromEntries(Object.entries(read).filter(([key, value]) => value !== defaults[key]));
}

/** How the outliner names an object: its kind's title, numbered where the kind stands more than once. */
export interface ObjectName {
  readonly title: string;
  /** Its number among its kind's objects in the document, where there are several; else "". */
  readonly label: string;
  /** Its kind, if the kinds offered know it. */
  readonly kind: KindDef | undefined;
}

/** Every object of `doc` named for the outliner, by id. */
export function objectNames(
  doc: EngineDoc,
  kinds: readonly KindDef[],
): ReadonlyMap<string, ObjectName> {
  const total = new Map<string, number>();
  for (const object of doc.objects) total.set(object.kind, (total.get(object.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = new Map<string, ObjectName>();
  for (const object of doc.objects) {
    const kind = kinds.find((candidate) => candidate.id === object.kind);
    const n = (seen.get(object.kind) ?? 0) + 1;
    seen.set(object.kind, n);
    names.set(object.id, {
      title: kind?.title ?? object.kind,
      label: (total.get(object.kind) ?? 0) > 1 ? String(n) : "",
      kind,
    });
  }
  return names;
}

/** One family's row of the palette: its kinds that answer the search, each with its refusal. */
export interface PaletteFamily {
  readonly family: (typeof FAMILIES)[number];
  readonly kinds: readonly { readonly kind: KindDef; readonly refusal: Refusal }[];
}

/**
 * The palette: `kinds` by family in the palette's order (each family's in the order given), those
 * answering `query` (an empty one answers every kind) by title, id, blurb or family, each with
 * why `doc` cannot take it. Families with no kind left out.
 */
export function palette(
  doc: EngineDoc,
  kinds: readonly KindDef[],
  query: string,
): readonly PaletteFamily[] {
  const text = query.trim().toLowerCase();
  return FAMILIES.map((family) => ({
    family,
    kinds: kinds
      .filter((kind) => kind.family === family.id)
      .filter(
        (kind) =>
          text === "" ||
          `${kind.title} ${kind.id} ${kind.blurb} ${family.title}`.toLowerCase().includes(text),
      )
      .map((kind) => ({ kind, refusal: kindRefusal(doc, kind, kinds) })),
  })).filter((row) => row.kinds.length > 0);
}
