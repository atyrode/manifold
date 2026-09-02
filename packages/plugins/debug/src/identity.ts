import { itemNoun } from "@manifold/plugin";
import { formatManifoldUri, type PluginRoster } from "@manifold/protocol";

/**
 * WHAT IS UNDER THE POINTER, decided from what the DOM says about itself — the whole of the
 * inspector's lookup logic, pure and with no DOM types in sight.
 *
 * The product already names itself in markup, because invariant 12 requires it: every mutating
 * affordance carries `data-action`, every sidebar row carries `data-section-id` and
 * `data-plugin`, every tile box carries `data-tile-id`, every workspace leaf carries
 * `data-panel-id`, and a canvas element is a React Flow node carrying `data-id`. Those
 * attributes were added one gate assertion at a time; read TOGETHER they are a complete
 * identity graph, and this module is the reading.
 *
 * It is pure for the reason every policy module in this repo is: the interesting part is the
 * PRECEDENCE — which of six declarations on an ancestor chain names the thing you are pointing
 * at, and which address that thing actually has — and precedence is what drifts silently. The
 * DOM half is a walk up `parentElement` in `dom.ts`, which has no decisions left in it.
 *
 * NOTHING HERE GUESSES AN ADDRESS. A tile in the routed composition has one; the identical
 * markup inside a canvas portal does not, because the DOM does not declare which container that
 * tree belongs to and an address invented from the routed container would be confidently wrong.
 * A missing address reads as "not addressable" in the chip, which is the truth.
 */

/** Which `data-*` attribute declares which kind of thing. The DOM's own vocabulary. */
export const IDENTITY_ATTRIBUTES = {
  section: "data-section-id",
  panel: "data-panel-id",
  tile: "data-tile-id",
  element: "data-id",
  plugin: "data-plugin",
  door: "data-action",
} as const;

/** What one declaration names. `door` is an action name; the rest are ids. */
export type DeclarationKind = keyof typeof IDENTITY_ATTRIBUTES;

/**
 * WHICH TILE TREE a `data-tile-id` belongs to, read off the skin its box wears. The three
 * skins are `@manifold/plugin/ui`'s three published class families (`TileTreeClasses`), and the
 * distinction is load-bearing rather than cosmetic: a `workspace` tile is a leaf of the
 * reader's own layout and has no address in any container, a `composition` tile belongs to the
 * routed container and therefore does, and a `portal` tile belongs to a container embedded in a
 * canvas whose id the DOM never declares — so it must not be addressed at all.
 */
export const TILE_TREES = ["workspace", "composition", "portal"] as const;
export type TileTree = (typeof TILE_TREES)[number];

/** The class prefix each skin's boxes wear, longest-match first (`portal__slot` before `portal`). */
const TREE_PREFIXES: readonly (readonly [string, TileTree])[] = [
  ["workspace-", "workspace"],
  ["composition-", "composition"],
  ["portal-", "portal"],
  ["portal__", "portal"],
];

/**
 * One element as this module reads it: the `data-*` attributes it carries and the classes it
 * wears. A plain record rather than an `Element`, so every rule below is testable without a
 * document (invariant 7: unit tests need no DOM).
 */
export interface Declared {
  readonly attributes: Readonly<Record<string, string>>;
  readonly classes: readonly string[];
}

/**
 * ONE HOP of the identity chain: what an ancestor declared itself to be, plus the owner it
 * declared beside it. Deliberately not called a frame — a frame is one JSON message on a socket
 * (REGISTRY.md §Lexicon) and one concept gets one word.
 */
export interface Declaration {
  readonly kind: DeclarationKind;
  /** The declared value: a section id, a panel id, a tile id, an element id, a plugin id, an action name. */
  readonly id: string;
  /** Which attribute carried it, so the chip can show its own evidence. */
  readonly attribute: string;
  /** The owning plugin, when the same element declared one (`data-plugin`). */
  readonly owner: string | null;
  /** Set for `tile` only: which of the three trees this box belongs to. */
  readonly tree: TileTree | null;
}

/**
 * The kinds in PRECEDENCE order for a single element: the most specific thing an element can
 * claim to be wins, and every element yields at most one hop.
 *
 * Order matters exactly once, and this is the case: a sidebar row carries `data-section-id` AND
 * `data-plugin`, and it is a section owned by that plugin — not a plugin. `data-plugin` alone
 * (the plugin manager's rows) genuinely names a plugin node, which is why it stays in the list
 * rather than becoming an owner-only attribute.
 */
const KIND_PRECEDENCE: readonly DeclarationKind[] = [
  "section",
  "panel",
  "tile",
  "element",
  "plugin",
  "door",
];

/** React Flow's node wrapper. Its `data-id` is only an element id on this class. */
const CANVAS_NODE_CLASS = "react-flow__node";

function treeOf(classes: readonly string[]): TileTree | null {
  for (const className of classes) {
    for (const [prefix, tree] of TREE_PREFIXES) {
      if (className.startsWith(prefix)) return tree;
    }
  }
  return null;
}

/** What one element declares, or null when it declares nothing this module understands. */
export function declarationOf(element: Declared): Declaration | null {
  for (const kind of KIND_PRECEDENCE) {
    const attribute = IDENTITY_ATTRIBUTES[kind];
    const id = element.attributes[attribute];
    if (id === undefined || id === "") continue;
    // `data-id` is React Flow's on a node and a handle's on a handle; only the node wrapper's
    // is an element id, so the class is part of the declaration rather than decoration.
    if (kind === "element" && !element.classes.includes(CANVAS_NODE_CLASS)) continue;
    const owner = element.attributes[IDENTITY_ATTRIBUTES.plugin];
    return {
      kind,
      id,
      attribute,
      owner: kind === "plugin" ? id : (owner ?? null),
      tree: kind === "tile" ? treeOf(element.classes) : null,
    };
  }
  return null;
}

/**
 * The identity chain, OUTERMOST FIRST — which is breadcrumb order, and the order a reader walks
 * back out through. The caller hands the ancestor walk innermost-first, because that is the
 * direction `parentElement` goes.
 */
export function chainOf(ancestors: readonly Declared[]): readonly Declaration[] {
  const chain: Declaration[] = [];
  for (const element of ancestors) {
    const declaration = declarationOf(element);
    if (declaration !== null) chain.push(declaration);
  }
  return chain.reverse();
}

/**
 * Which plugin an action name belongs to: the longest registered plugin id that is a dotted
 * prefix of it. Longest wins because plugin ids nest (`core.index` and a hypothetical
 * `core.index.tree` would both prefix `core.index.tree.move`), and asking the roster rather
 * than splitting on the last dot is what keeps a dotted local name from inventing a plugin.
 */
export function actionOwner(actionName: string, pluginIds: readonly string[]): string | null {
  let best: string | null = null;
  for (const id of pluginIds) {
    if (!actionName.startsWith(`${id}.`)) continue;
    if (best === null || id.length > best.length) best = id;
  }
  return best;
}

/**
 * What the live composition answers about a declared id. Injected rather than imported: the
 * inspector reads it off `host.assembly`, and the tests read it off a literal.
 */
export interface CompositionLookup {
  sectionOwner(sectionId: string): string | null;
  panelOwner(panelId: string): string | null;
  actionOwner(actionName: string): string | null;
}

/**
 * THE ADDRESS of one declaration, or null when the thing genuinely has none.
 *
 * A `manifold://` address is the canonical reference form for anything addressable (invariant
 * 13), and the seven forms are the protocol's (`packages/protocol/src/uri.ts`). Three of the six
 * declaration kinds map onto one directly; the other three are addressed through their owner,
 * which is what {@link identify} falls back to.
 */
export function declarationAddress(
  declaration: Declaration,
  routedContainerId: string | null,
): string | null {
  switch (declaration.kind) {
    case "door":
      return formatManifoldUri({ kind: "action", actionName: declaration.id });
    case "tile":
      // Only the ROUTED container's own tree can be addressed: see the module note.
      return declaration.tree === "composition" && routedContainerId !== null
        ? formatManifoldUri({
            kind: "tile",
            containerId: routedContainerId,
            tileId: declaration.id,
          })
        : null;
    case "element":
      return routedContainerId === null
        ? null
        : formatManifoldUri({
            kind: "element",
            containerId: routedContainerId,
            elementId: declaration.id,
          });
    case "plugin":
      return formatManifoldUri({ kind: "plugin", pluginId: declaration.id });
    case "section":
    case "panel":
      return null;
    default: {
      const exhaustive: never = declaration.kind;
      return exhaustive;
    }
  }
}

/** Who owns one declaration, asked of the DOM first and of the composition second. */
export function declarationOwner(
  declaration: Declaration,
  composition: CompositionLookup,
): string | null {
  if (declaration.owner !== null) return declaration.owner;
  switch (declaration.kind) {
    case "section":
      return composition.sectionOwner(declaration.id);
    case "panel":
      return composition.panelOwner(declaration.id);
    case "door":
      return composition.actionOwner(declaration.id);
    case "tile":
    case "element":
    case "plugin":
      return null;
    default: {
      const exhaustive: never = declaration.kind;
      return exhaustive;
    }
  }
}

/** What the inspector knows about one point of the workspace. */
export interface Identity {
  /** The whole chain, outermost first: the breadcrumb, and every hop of it. */
  readonly chain: readonly Declaration[];
  /** The INNERMOST declaration — the thing actually under the pointer. */
  readonly subject: Declaration | null;
  /**
   * The address of the subject, or of the innermost hop that HAS one, or the owning plugin's.
   * Null only when nothing on the chain names anything addressable.
   */
  readonly uri: string | null;
  /** Which plugin owns the subject: the innermost hop that answers. */
  readonly plugin: string | null;
}

export interface IdentityContext {
  readonly routedContainerId: string | null;
  readonly composition: CompositionLookup;
}

/**
 * The lookup, end to end: an ancestor walk in, an identity out.
 *
 * The address is the innermost one AVAILABLE rather than strictly the subject's, and that is the
 * design: pointing at a sidebar row's label lands on a `section`, which has no address form of
 * its own, and answering "not addressable" while the row's owner sits one hop up would be
 * withholding the answer the reader asked for. Owner address last, subject address first — most
 * specific wins, always.
 */
export function identify(ancestors: readonly Declared[], context: IdentityContext): Identity {
  const chain = chainOf(ancestors);
  const subject = chain.length === 0 ? null : (chain[chain.length - 1] ?? null);
  let uri: string | null = null;
  let plugin: string | null = null;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const declaration = chain[index];
    if (declaration === undefined) continue;
    if (uri === null) uri = declarationAddress(declaration, context.routedContainerId);
    if (plugin === null) plugin = declarationOwner(declaration, context.composition);
    if (uri !== null && plugin !== null) break;
  }
  if (uri === null && plugin !== null) {
    uri = formatManifoldUri({ kind: "plugin", pluginId: plugin });
  }
  return { chain, subject, uri, plugin };
}

/**
 * WHAT TO CALL IT. The two kinds that are also item kinds take the workspace's one label
 * vocabulary (`ITEM_NOUNS` through `itemNoun`, the only kind→noun table in the tree, S12); the
 * other four are not items at all and take the canon word for what they are (REGISTRY.md
 * §Lexicon: a section is a section, a door is a door).
 */
const DECLARATION_NOUNS: Readonly<Record<"section" | "element" | "plugin" | "door", string>> = {
  section: "section",
  element: "element",
  plugin: "plugin",
  door: "door",
};

export function declarationNoun(declaration: Declaration, roster: PluginRoster): string {
  return declaration.kind === "tile" || declaration.kind === "panel"
    ? itemNoun(declaration.kind, roster)
    : DECLARATION_NOUNS[declaration.kind];
}

/**
 * EVERY DOOR REACHABLE UNDER a pinned element, deduplicated and sorted.
 *
 * Sorted rather than in DOM order on purpose: this is a list a reader compares between two
 * pins, and "which doors does this thing open" is a set question. Deduplicated because one
 * affordance is often several elements (a row's grip and its keyboard nudge name one door).
 */
export function distinctDoors(names: readonly string[]): readonly string[] {
  return [...new Set(names.filter((name) => name !== ""))].sort();
}

/** The one selector that finds every declared thing, for the descendant count and the doors. */
export const IDENTITY_SELECTOR = Object.values(IDENTITY_ATTRIBUTES)
  .map((attribute) => `[${attribute}]`)
  .join(",");

export const DOOR_SELECTOR = `[${IDENTITY_ATTRIBUTES.door}]`;
