import type {
  CarriedItem,
  Carry,
  CarryAim,
  Gesture,
  PlacementItem,
  PlacementRef,
  PluginRoster,
  TileRef,
} from "@manifold/protocol";
import { envelopeRef, type ItemEnvelope } from "./item-envelope.ts";
import { ITEM_NOUNS, itemNoun } from "./item-noun.ts";
import type { GestureOverride } from "./presence/index.ts";

/**
 * The dynamic half of the placement algebra, as pure functions.
 *
 * Grabbing anything by its chrome is ONE carry: the source container mutates live, the
 * carried representation renders under the cursor, and the gesture streams to
 * collaborators over the room's existing gesture channel. This module owns the two
 * translations that would otherwise be re-invented per renderer and per element type —
 * a local grab into a wire frame, and a peer's frames into the ghosts a renderer paints.
 *
 * Everything here is coordinate-space agnostic. A canvas streams flow coordinates and a
 * composition streams tile-area fractions, exactly as each already does for cursors; a
 * carry frame is read back in the space it was written in, so neither renderer has to
 * know the other exists.
 */

/** Where a carried representation renders, in the room's own coordinate space. */
export interface CarryPoint {
  readonly x: number;
  readonly y: number;
  /** The source box, when the carried object still has one here (a canvas element). */
  readonly width?: number;
  readonly height?: number;
}

/** One live grab: what is held, what it IS, what to call it, and its streaming id. */
export interface CarrySource {
  /**
   * The gesture's key. It is the carried object's PLACEMENT id wherever it has one, so
   * a viewer's override lands on the very thing being moved — which is what makes the
   * source container mutate live rather than needing a second gesture beside the carry.
   */
  readonly id: string;
  readonly envelope: ItemEnvelope;
  /**
   * The item the envelope names, resolved where the grab happened. It rides every frame
   * because a watcher cannot derive it: classifying a ref takes a census of
   * containers, terminals and solo occupancy, and a watcher's copy of that census is a
   * poll behind the drag that just started.
   */
  readonly item: PlacementItem;
  readonly label: string | null;
}

/**
 * The placement id an envelope carries under, or null when the item is unplaced (a
 * pooled terminal), named by identity alone (a container dragged from the sidebar), or
 * not yet a thing at all (a palette carry, whose structure exists only after the drop).
 * A null gets a synthetic id from the caller: a carry always has a key, because a
 * carry with no key could not be ended.
 */
export function carryPlacementId(envelope: ItemEnvelope): string | null {
  switch (envelope.kind) {
    case "element":
      return envelope.elementId;
    case "tile":
      return envelope.tileId;
    case "terminal":
    case "canvas":
    case "composition":
    case "structure":
      return null;
    default: {
      const exhaustive: never = envelope;
      return exhaustive;
    }
  }
}

/** The wire payload of one grab; `aim` is the resolved drop target while one is armed. */
export function carryPayload(source: CarrySource, aim?: CarryAim): Carry {
  return {
    ref: envelopeRef(source.envelope),
    item: source.item,
    ...(source.label === null ? {} : { label: source.label }),
    ...(aim === undefined ? {} : { aim }),
  };
}

/**
 * One frame. Geometry says where the carried representation is right now: for an object
 * still drawn in its source container that is the object's own live box, so the frame
 * doubles as the move it used to send; for everything else it is the pointer, which is
 * where the ghost belongs. `aim` rides along while the producer has a drop target
 * armed, so every viewer can re-derive the SAME split preview from the same kernel —
 * multiplayer is the design, and a local drag is just the case where the producer is
 * your own pointer. An agent driving a carry through the SDK paints identically.
 */
export function carryFrame(
  source: CarrySource,
  at: CarryPoint,
  phase: Gesture["phase"],
  aim?: CarryAim,
): Gesture {
  return {
    kind: "carry",
    phase,
    elementId: source.id,
    x: at.x,
    y: at.y,
    ...(at.width === undefined ? {} : { width: at.width }),
    ...(at.height === undefined ? {} : { height: at.height }),
    carry: carryPayload(source, aim),
  };
}

/**
 * The same frame with NO item named: `move`, which the gesture vocabulary defines as how
 * one placed object's own geometry is changing. It exists because the grabber is NOT in
 * fact guaranteed to hold the census `CarrySchema.item` assumes: a document arrives over
 * the room socket while the container index arrives over a poll, so a collaborator
 * renders a portal onto a newborn container for up to one poll interval before anything
 * can tell it what that container IS.
 *
 * A grab in that window still owes every viewer the MOTION — the object is in the room
 * they already render, so WHERE is the whole of what they need — and owes them no claim
 * about a placement nobody here can judge, which is exactly what omitting the carry
 * says. Publishing nothing instead is how a peer's drag became a teleport on release.
 */
export function moveFrame(placementId: string, at: CarryPoint, phase: Gesture["phase"]): Gesture {
  return {
    kind: "move",
    phase,
    elementId: placementId,
    x: at.x,
    y: at.y,
    ...(at.width === undefined ? {} : { width: at.width }),
    ...(at.height === undefined ? {} : { height: at.height }),
  };
}

/**
 * The fallback name for a carry whose sender sent none is the ONE label vocabulary,
 * keyed by the ITEM the carry names rather than by the shape of its address — which is
 * why there is no table here. A ref kind is an address form (`container`), an item kind
 * is a species (`canvas`, `composition`), and the table that used to translate between
 * them is exactly the disagreement `verify:axioms` S12 now forbids: it said "view" while
 * the icons said "canvas" and the refusals said "A canvas". The carry already carries its
 * item, so nothing needs translating; a kind with no floor noun is a contributed element,
 * whose producer always sends the plugin's own title as `label`.
 *
 * It stays a NAME for the one table rather than a call to {@link itemNoun} because a ghost is
 * derived from wire frames alone, with no roster in hand — and by the sentence above, the only
 * kinds that ever reach this fallback are floor kinds, whose word `itemNoun` would read out of
 * this very object. The trailing `?? "item"` is that function's generic, spelled once here.
 */
const FALLBACK_NOUNS: Readonly<Record<string, string>> = ITEM_NOUNS;

/**
 * Past this a borrowed first line stops being a name and starts being the content it was
 * borrowed from. One bound for every text-bearing kind, because the caption slot they share
 * is one width.
 */
const FIRST_LINE_LABEL_LENGTH = 40;

/**
 * The display label a TEXT-BEARING element borrows from its OWN content: an element that
 * holds prose carries no name field, so its first line is the only handle it has. Null while
 * the content is empty, which is what hands the naming question on to the one noun door
 * ({@link itemNoun}).
 *
 * The floor states the RULE and never the word. This function used to be `noteTitle`, and a
 * note is `core.notes`' object: the engine cannot spell one plugin's element without owing
 * every other plugin the same favour, and the neutrality criterion (§Foundation law) is
 * exactly that it "would be unchanged if every plugin in the tree were replaced".
 */
export function firstLineLabel(text: string): string | null {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length <= FIRST_LINE_LABEL_LENGTH
    ? firstLine
    : `${firstLine.slice(0, FIRST_LINE_LABEL_LENGTH - 1)}…`;
}

/**
 * What an element BEARS, as its host reads it out of the document: its declared
 * wire type and any text content. A drawing supplies an empty string and names itself
 * from its declaring plugin's vocabulary; the element ref is addressing, not species.
 */
export interface RefElementContent {
  readonly type: string;
  readonly text: string;
}

/**
 * The three questions naming a tile ref asks of a host's own documents, plus the vocabulary
 * that answers the fourth. Every host can answer all three — a route from its room, a canvas
 * portal from its portal socket plus the container index the canvas holds — so no host owns a
 * private switch. The `roster` rides with them because a label that has to fall back must
 * fall back to the declaring plugin's own word, and a caller passing that word in as a
 * default was every renderer holding a copy of one plugin's noun.
 */
export interface RefLabelLookups {
  readonly terminalName: (terminalId: string) => string | null;
  readonly containerName: (containerId: string) => string | null;
  /** The element as borne; the first-line rule is applied here, once, for everyone. */
  readonly elementContent: (elementId: string) => RefElementContent | null;
  /** The composed vocabulary, for the noun a nameless kind falls back to. */
  readonly roster: PluginRoster;
}

/**
 * What a tile ref is CALLED. One switch for the whole application: the fullscreen
 * route and a canvas portal differ only in the documents they read, never in which
 * species they can name — which is what stopped a displaced canvas or note from
 * captioning on the route and captioning nothing inside a portal.
 */
export function refDisplayLabel(ref: TileRef | null, lookups: RefLabelLookups): string | null {
  switch (ref?.kind) {
    case "terminal":
      return lookups.terminalName(ref.terminalId);
    case "container":
      return lookups.containerName(ref.containerId);
    case "element": {
      const element = lookups.elementContent(ref.elementId);
      if (element === null) return null;
      /*
        An element holding nothing is not nameless: it is called whatever its own plugin calls
        that element type, which is the manifest title `itemNoun` reads. Answering null here
        pushed the question to a caller, and every caller answered it with the literal "note"
        — one plugin's word, copied into three renderers, for a ref form that any plugin's
        text-bearing element may address.
      */
      return firstLineLabel(element.text) ?? itemNoun(element.type, lookups.roster);
    }
    case "panel":
      // A panel's human title lives in the composition, which this module deliberately
      // cannot see: labelling reads DOCUMENTS, and a panel is not in one. The panel id is
      // fully qualified, so it is a truthful name rather than a placeholder.
      return ref.panelId;
    case "spacer":
      // A spacer carries no data to name itself with — it is the whole of its own label.
      return "Spacer";
    case undefined:
      return null;
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}

/** What a collaborator paints under a carrier's pointer. */
export interface CarryGhost {
  readonly key: string;
  readonly principalId: string;
  /** The ITEM kind carried, open by design: a floor species or a contributed element type. */
  readonly kind: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The ghosts one renderer owes its viewers, out of the same override map that drives
 * remote geometry. `rendersRef` is the renderer's single question: does this room
 * already draw the carried object? When it does, the override IS the representation —
 * the element moves under the peer's pointer — and a second chip on top of it would be
 * the same object drawn twice. When it does not (a pooled terminal, a tile lifted off a
 * portal, a container dragged in from the sidebar), the ghost is the only thing there is.
 *
 * An AIM-ONLY frame has no ghost at all: it reached this room because its aim addresses
 * this container, while the pointer that produced it is somewhere else entirely, so its
 * coordinates are another room's. The preview it feeds is the whole of what it says here.
 */
export function carryGhosts(
  overrides: Iterable<GestureOverride>,
  rendersRef: (ref: PlacementRef, override: GestureOverride) => boolean,
): readonly CarryGhost[] {
  const ghosts: CarryGhost[] = [];
  for (const override of overrides) {
    const carry = override.carry;
    if (override.kind !== "carry" || carry === undefined || override.aimOnly === true) continue;
    if (rendersRef(carry.ref, override)) continue;
    ghosts.push({
      key: `${override.connId}:${override.elementId}`,
      principalId: override.principalId,
      kind: carry.item.kind,
      label: carry.label ?? FALLBACK_NOUNS[carry.item.kind] ?? "item",
      x: override.current.x,
      y: override.current.y,
    });
  }
  return ghosts;
}

/**
 * A peer's carry that is currently AIMING at a tile target: everything a preview
 * overlay needs to re-derive the producer's exact split preview from the shared
 * geometry kernel.
 */
export interface RemoteTileCarry extends CarriedItem {
  readonly connId: string;
  readonly principalId: string;
  readonly aim: CarryAim;
  readonly label: string;
  readonly updatedAt: number;
}

/**
 * The freshest live aim PER CONTAINER, keyed by the container each aim addresses.
 *
 * Freshest-wins is right for one tile area and wrong for a room: a canvas draws many
 * portals, so a single winner across every override let peer A aiming at portal 1 and
 * peer B at portal 2 mask each other — the two flipped on every frame as their receipt
 * timestamps alternated and the loser's portal went blank. Two carries over the SAME
 * area still contradict each other, and there the freshest is the honest answer.
 */
export function remoteTileCarries(
  overrides: Iterable<GestureOverride>,
): ReadonlyMap<string, RemoteTileCarry> {
  const latest = new Map<string, RemoteTileCarry>();
  for (const override of overrides) {
    const carry = override.carry;
    if (override.kind !== "carry" || carry === undefined || carry.aim === undefined) continue;
    const held = latest.get(carry.aim.containerId);
    if (held !== undefined && override.updatedAt <= held.updatedAt) continue;
    latest.set(carry.aim.containerId, {
      connId: override.connId,
      principalId: override.principalId,
      aim: carry.aim,
      ref: carry.ref,
      item: carry.item,
      label: carry.label ?? FALLBACK_NOUNS[carry.item.kind] ?? "item",
      updatedAt: override.updatedAt,
    });
  }
  return latest;
}
