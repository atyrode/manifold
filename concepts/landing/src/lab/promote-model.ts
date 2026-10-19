// Promotion (ADR 0062 D15): a saved or committed preset of an interior variant made a curated
// variant of its own. The preset's query folds into its source variant's differences from the
// baseline: a layer's switch into the layers added or removed, `elements=` into its elements, the
// look and the accent into its identity, every other knob into its values; its camera, room and
// grade are the source's, and `from` records the commit and query it came from. A value the baseline
// already holds is dropped, as interior-variants.test.ts would refuse it. A key a variant cannot
// hold (a lab setting, the planets' list, a pose) refuses the promotion with its reason, and so does
// a preset that does not load as itself on this build (presets.test.ts's rule): load it and save it
// again first. The fold is checked before it is offered: the variant composed must list the
// query's knobs at the query's values, its look, accent and elements, or it is refused.
//
// The lab cannot write files, so the promotion is an entry for composer/interior-variants.ts as
// TypeScript text, which `bun concepts/landing/scripts/promote.ts <query>` writes there, removing
// the committed preset it came from.
import { canonicalSetup } from "../compare.ts";
import { ComposeError, composeScene, variantPreset } from "../composer/compose.ts";
import { ELEMENTS_KEY, encodeElements } from "../composer/elements.ts";
import { interior } from "../composer/interior.ts";
import {
  identityOf,
  interiorVariants,
  sourceRoom,
  type FolderVariantId,
} from "../composer/interior-variants.ts";
import type { LightElement, Variant } from "../composer/types.ts";
import { readKnobs } from "../params.ts";
import type { Preset } from "../presets.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import type { SceneLook } from "../scenes/types.ts";
import { defaults, readSetup } from "../state.ts";

/** What a promoted variant is called: its scene id (lowercase letters), title and blurb. */
export interface PromotedNames {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
}

/** A promotion: the variant and its entry, or why the preset cannot be promoted. */
export type Promotion =
  | {
      readonly ok: true;
      readonly variant: Variant;
      /** The room in its folder whose identity it borrows (`identityOf`). */
      readonly room: FolderVariantId;
      /** The entry for composer/interior-variants.ts's `promotedInteriorVariants`. */
      readonly entry: string;
    }
  | { readonly ok: false; readonly reason: string };

/** The interior variant whose preset `query` is, or undefined for any other scene's. */
export function promotedFrom(query: string): Variant | undefined {
  return interiorVariants[new URLSearchParams(query).get("scene") ?? defaults.scene];
}

/**
 * Why `preset` may not be promoted on this build, or undefined when it may: it must be an interior
 * variant's (else "not a room"), load as itself (its query as this build writes it) and differ from
 * its scene's defaults.
 */
export function promotionBlocked(preset: Preset): string | undefined {
  if (promotedFrom(preset.query) === undefined) return "not a room: only rooms promote yet";
  const query = new URLSearchParams(preset.query);
  if (canonicalSetup(query) !== preset.query)
    return "it does not load as itself on this build: load it and save it again first";
  if ([...query.keys()].every((key) => key === "scene"))
    return "it is its scene at its defaults: nothing of its own to promote";
  return undefined;
}

/** Words a preset's name leaves out of the id it suggests. */
const SMALL_WORDS: Readonly<Record<string, true>> = {
  a: true,
  an: true,
  and: true,
  at: true,
  by: true,
  in: true,
  of: true,
  on: true,
  the: true,
  with: true,
};

/**
 * The names a promotion of `preset` starts from: the name's part after its scene ("Sill · lava lamp
 * on the sill" → "Lava lamp on the sill"), an id of the source's id and that part's first word
 * ("silllava", lettered on past any taken), and a blurb naming both.
 */
export function suggestNames(preset: Preset, taken: readonly string[] = sceneIds): PromotedNames {
  const source = promotedFrom(preset.query);
  const sceneTitle = source?.title ?? "";
  const [head = "", ...rest] = preset.name.split(" · ");
  const own = (rest.length > 0 && head === sceneTitle ? rest.join(" · ") : preset.name).trim();
  const word =
    own
      .toLowerCase()
      .split(/[^a-z]+/)
      .find((part) => part !== "" && SMALL_WORDS[part] !== true) ?? "";
  const stem = `${source?.id ?? ""}${word}`.replace(/[^a-z]/g, "") || "room";
  const suffix = ["", ..."bcdefghijklmnopqrstuvwxyz"].find((end) => !taken.includes(stem + end));
  return {
    id: `${stem}${suffix ?? "z"}`,
    title: own.charAt(0).toUpperCase() + own.slice(1),
    blurb: `${sceneTitle}: ${own}.`,
  };
}

/** Why `names` cannot name a new scene, or undefined when they can. */
export function namesBlocked(
  names: PromotedNames,
  taken: readonly string[] = sceneIds,
): string | undefined {
  if (!/^[a-z]+$/.test(names.id)) return "the id takes lowercase letters only";
  if (taken.includes(names.id)) return `${names.id} is a scene already`;
  if (names.title.trim() === "") return "it needs a title";
  if (names.blurb.trim() === "") return "it needs a blurb";
  return undefined;
}

/** `preset` made a variant named `names` (see the header), or why it cannot be. */
export function promote(preset: Preset, names: PromotedNames): Promotion {
  const refuse = (reason: string): Promotion => ({ ok: false, reason });
  const blocked = promotionBlocked(preset) ?? namesBlocked(names);
  if (blocked !== undefined) return refuse(blocked);
  const source = promotedFrom(preset.query);
  if (source === undefined) return refuse("not a room");
  const room = sourceRoom(source);
  const query = new URLSearchParams(preset.query);
  const setup = readSetup(query);
  const def = sceneDefs[setup.state.scene];
  const offered = def.layers?.offered.map((layer) => layer.id) ?? [];

  const look: SceneLook = { ...source.look };
  let accent = source.accent;
  const switches: Record<string, boolean> = {};
  const values: Record<string, number> = { ...source.values };
  let elements: readonly LightElement[] | undefined = source.elements;
  const held: string[] = [];
  for (const key of new Set(query.keys())) {
    const knob = setup.params[key];
    if (key === "scene") continue;
    else if (key === "color") look.color = setup.state.color;
    else if (key === "levels") look.levels = setup.state.levels;
    else if (key === "accent") accent = setup.state.accent;
    else if (key in defaults) held.push(`${key} (a lab setting)`);
    else if (key === ELEMENTS_KEY && def.elements !== undefined) elements = setup.elements;
    else if (knob === undefined) held.push(`${key}= (no variant field holds it)`);
    else if (offered.includes(key)) switches[key] = knob > 0;
    else values[key] = knob;
  }
  if (held.length > 0) return refuse(`a variant cannot hold ${held.join(", ")}`);

  // The layers on: the source's home layers, switched as the query switches them, as differences
  // from the baseline's: added in canonical order, removed in the baseline's.
  const baseline = interior.baseline;
  const home = new Set(variantPreset(baseline, source).layers);
  for (const [id, on] of Object.entries(switches)) {
    if (on) home.add(id);
    else home.delete(id);
  }
  const add = interior.layers.map((layer) => layer.id).filter((id) => home.has(id));
  const layers = {
    add: add.filter((id) => !baseline.layers.includes(id)),
    remove: baseline.layers.filter((id) => !home.has(id)),
  };
  const variant: Variant = {
    id: names.id,
    base: "interior",
    title: names.title.trim(),
    blurb: names.blurb.trim(),
    accent,
    ...(Object.keys(look).length === 0 ? {} : { look }),
    ...identityOf(source),
    ...(layers.add.length + layers.remove.length === 0
      ? {}
      : {
          layers: {
            ...(layers.add.length === 0 ? {} : { add: layers.add }),
            ...(layers.remove.length === 0 ? {} : { remove: layers.remove }),
          },
        }),
    ...(source.camera === undefined ? {} : { camera: source.camera }),
    ...(source.room === undefined ? {} : { room: source.room }),
    ...(source.grade === undefined ? {} : { grade: source.grade }),
    ...(elements === undefined || encodeElements(elements) === encodeElements(baseline.elements)
      ? {}
      : { elements }),
    from: { commit: preset.commit, query: preset.query },
  };

  try {
    // Each value the baseline holds already over these layers (its own or its knob's default) goes.
    const plain = composeScene(interior, variantPreset(baseline, { ...variant, values: {} }));
    const fallback = readKnobs(plain.def.params, () => null);
    const kept = Object.entries(values).filter(([key, value]) => fallback[key] !== value);
    const promoted: Variant =
      kept.length === 0 ? variant : { ...variant, values: Object.fromEntries(kept) };

    // The check: the variant's defaults are the query's setup.
    const composed = composeScene(interior, variantPreset(baseline, promoted)).def;
    const knobs = readKnobs(composed.params, () => null);
    const apart = [...new Set([...Object.keys(knobs), ...Object.keys(setup.params)])].filter(
      (key) => knobs[key] !== setup.params[key],
    );
    if ((composed.look?.color ?? defaults.color) !== setup.state.color) apart.push("color");
    if ((composed.look?.levels ?? defaults.levels) !== setup.state.levels) apart.push("levels");
    if (composed.accent !== (setup.state.accent || def.accent)) apart.push("accent");
    if (encodeElements(composed.elements?.defaults ?? []) !== encodeElements(setup.elements))
      apart.push(ELEMENTS_KEY);
    if (apart.length > 0)
      return refuse(`the variant would not draw its query: ${apart.join(", ")}`);
    return { ok: true, variant: promoted, room, entry: variantEntry(promoted, room) };
  } catch (error: unknown) {
    if (error instanceof ComposeError) return refuse(`it does not compose: ${error.message}`);
    throw error;
  }
}

/** The width an entry's line is kept within, as prettier keeps the repository's. */
const WIDTH = 100;

/** `value` as a TypeScript literal at indent `indent`, broken over lines past WIDTH. */
function literal(value: unknown, indent: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object" || value === null)
    throw new Error(`no literal for ${String(value)}`);
  const inner = `${indent}  `;
  const parts = Array.isArray(value)
    ? value.map((item: unknown) => literal(item, inner))
    : Object.entries(value).map(
        ([key, item]) =>
          `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${literal(item, inner)}`,
      );
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{ ", " }"];
  if (parts.length === 0) return Array.isArray(value) ? "[]" : "{}";
  const flat = `${open}${parts.join(", ")}${close}`;
  if (indent.length + flat.length <= WIDTH && !flat.includes("\n")) return flat;
  return `${open.trim()}\n${parts.map((part) => `${inner}${part},`).join("\n")}\n${indent}${close.trim()}`;
}

/**
 * `variant`'s entry in `promotedInteriorVariants`, keyed by its id: its own fields as literals and
 * `...identityOf(<room>Variant)` for what it borrows of its room's identity.
 */
export function variantEntry(variant: Variant, room: FolderVariantId): string {
  const indent = "    ";
  const field = (key: string, value: unknown) => `${indent}${key}: ${literal(value, indent)},`;
  const lines = [
    `  ${variant.id}: {`,
    field("id", variant.id),
    field("base", variant.base),
    field("title", variant.title),
    field("blurb", variant.blurb),
    field("accent", variant.accent),
    ...(variant.look === undefined ? [] : [field("look", variant.look)]),
    `${indent}...identityOf(${room}Variant),`,
    ...(["layers", "values", "camera", "room", "grade", "elements", "from"] as const).flatMap(
      (key) => (variant[key] === undefined ? [] : [field(key, variant[key])]),
    ),
    "  },",
  ];
  return lines.join("\n");
}
