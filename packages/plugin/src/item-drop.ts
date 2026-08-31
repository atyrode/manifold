import {
  placementItemFor,
  resolveCarriedPlacement,
  resolvePlacement,
  type CarriedItem,
  type ContainerLayout,
  type ContainerKind,
  type ItemKind,
  type Pad,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementSurface,
  type PluginRoster,
  type SceneElement,
} from "@manifold/protocol";
import { rosterElementTraits } from "./compose.ts";
import type { PlaceOutcome } from "./host.ts";
import { useCallback, useMemo } from "react";
import {
  carriedPlacement,
  envelopeSurface,
  readEnvelope,
  type ItemEnvelope,
} from "./item-envelope.ts";

/**
 * THE drop pipeline. Every destination in the application — the canvas pane, a canvas
 * node, a composition's tile leaf, a sidebar container row, the index's top level — registers
 * against this one layer, hands it the `PlacementDestination` it means, and gets three
 * things: legality for the drag preview, the refusal to wear while refusing, and the
 * write on release.
 *
 * The point is that no target decides anything. Legality is `resolvePlacement` over the
 * protocol's declarations, run against the SAME state the write will see, so a preview can
 * never disagree with the server; a refusal names the declared rule that refused it. That
 * is what closes the gaps this replaces by construction: a container dropped on bare
 * canvas authors a portal because `canvas accepts canvas-item-as-portal`, and a terminal
 * dropped on a composition row lands as a tile because `view accepts tileable` — neither
 * needed a new branch, only a destination.
 *
 * It lives in the ENGINE, beside the envelope it reads, because "a sidebar container row"
 * in that list is now a plugin and "the canvas pane" is still floor. Both must judge the
 * same drag by the same rules; a plugin-side copy of the assessment would be a second
 * answer to a question the protocol already answers once (AGENTS.md invariant 14).
 */

/**
 * Prose per FLOOR item kind. The rule is machine-readable; this is what a person reads.
 *
 * Contributed element kinds are absent on purpose: their names belong to their plugins, so
 * a refusal about one reads the TITLE its manifest declared (see `ItemLookup.noun`). A
 * floor table naming them would be the closed table §12 just opened, rebuilt in prose.
 */
const ITEM_NOUN: Readonly<Record<ItemKind, string>> = {
  terminal: "A terminal",
  "canvas-pad": "A canvas",
  view: "A composition",
  tile: "A tile",
  panel: "A panel",
};

/**
 * Prose per container kind, in the object position of every refusal sentence. `unplaced`
 * is not a place, so it reads as the one thing it actually is: the index's top level,
 * where an item that nothing references sits.
 */
const CONTAINER_NOUN: Record<ContainerKind, string> = {
  canvas: "a canvas",
  view: "a composition",
  unplaced: "the index",
};

/**
 * State the algebra asks about, answered from what this renderer already holds: the
 * container index the sidebar fetched, the container this renderer IS, and its live
 * elements. The server answers the same two questions from its rows and rooms, which is
 * the whole reason a preview and the write it precedes cannot drift.
 */
export interface PlacementLookupInputs {
  /** Every container the sidebar indexes; a drag source is always one of these. */
  readonly pads: readonly Pad[];
  /** The container being rendered, whose row may not have arrived yet (a newborn view). */
  readonly self: { readonly padId: string; readonly layout: ContainerLayout } | null;
  /** Live elements of `self`; empty for a composition, which places no elements freely. */
  readonly elements: ReadonlyMap<string, SceneElement>;
  /**
   * The composition each terminal lives in. Every terminal has one from birth, so a miss
   * here means no such session — a denial, never a terminal without a home.
   */
  readonly terminalHomes: ReadonlyMap<string, string>;
  /**
   * What a container holds when it holds exactly ONE item. This is the whole of
   * "compositions merge, never nest": placement looks THROUGH a solo composition to its
   * occupant, so a canvas portal onto a lone terminal drags as that terminal. Absent for
   * a container this surface has no census of, which denies `not_solo` rather than
   * merging something it cannot see — conservative, never wrong.
   */
  readonly soloOccupants: ReadonlyMap<string, PlacementItem>;
  /**
   * The composition as the server published it. It is where every CONTRIBUTED element
   * kind's placement traits come from (ADR 0013 §12), and it is REQUIRED rather than
   * optional because a lookup without it would preview-refuse gestures the server accepts
   * — a drag that lies about legality is worse than no preview at all.
   */
  readonly roster: PluginRoster;
}

/**
 * The lookup a renderer builds: every question the algebra asks, plus the one question only
 * a roster can answer — what to CALL a kind in a refusal. Legality and prose come from the
 * same object because they come from the same composition, and a caller holding one of them
 * without the other is how a preview and its sentence come to disagree.
 */
export interface ItemLookup extends PlacementLookup {
  noun(kind: string): string;
}

export function createPlacementLookup(inputs: PlacementLookupInputs): ItemLookup {
  const layoutOf = (padId: string): ContainerLayout | null => {
    if (inputs.self?.padId === padId) return inputs.self.layout;
    return inputs.pads.find((pad) => pad.id === padId)?.layout ?? null;
  };
  const traits = rosterElementTraits(inputs.roster);
  // A refusal about a contributed kind says what its PLUGIN calls it: the plugin owns the
  // noun, the floor owns the grammar. That division is why the engine can render a sentence
  // about a kind it has never heard of.
  const nouns = new Map<string, string>();
  for (const entry of inputs.roster) {
    for (const element of entry.manifest.contributes.elements) {
      const noun = element.title.toLowerCase();
      nouns.set(element.type, `${/^[aeiou]/.test(noun) ? "An" : "A"} ${noun}`);
    }
  }
  const floorNouns: Readonly<Record<string, string>> = ITEM_NOUN;
  return {
    padLayout: layoutOf,
    elementItem: (padId, elementId) => {
      // Only this renderer's own document is visible from here. Another container's
      // elements are not knowable without a socket, and no gesture addresses them.
      if (inputs.self?.padId !== padId) return null;
      const element = inputs.elements.get(elementId);
      if (element === undefined) return null;
      if (element.type === "portal") {
        // A portal places the container it points at, so THAT container's discipline
        // decides the kind — and a portal onto an unknown container places nothing.
        // A terminal on a canvas IS this case: its portal points at its home.
        const layout = layoutOf(element.containerId);
        if (layout === null) return null;
        return {
          kind: layout === "canvas" ? "canvas-pad" : "view",
          containerId: element.containerId,
        };
      }
      // Every other element PLACES ITS OWN TYPE, and the traits that decide its legality
      // arrive with the type from the roster. No arm per element kind: that switch was the
      // engine learning a plugin's name (§12).
      return { kind: element.type, containerId: null };
    },
    terminalHome: (sessionId) => inputs.terminalHomes.get(sessionId) ?? null,
    soloOccupant: (padId) => inputs.soloOccupants.get(padId) ?? null,
    itemTraits: (kind) => traits.get(kind) ?? null,
    noun: (kind) => floorNouns[kind] ?? nouns.get(kind) ?? "That item",
  };
}

/**
 * A refusal in prose, derived from the declared rule and the two nouns involved. There is
 * one sentence per rule and no table of pairs: the rule already says WHY, so growing the
 * vocabulary of items or containers never grows this function. The table is keyed by the
 * exported rule union, so a rule added to the algebra cannot ship without a sentence.
 */
const DENIAL_PROSE: Record<PlacementDenialRule, (subject: string, container: string) => string> = {
  not_accepted: (subject, container) => `${subject} does not go in ${container}.`,
  self_embed: (subject) => `${subject} cannot be placed inside itself.`,
  discipline: (subject, container) => `${subject} cannot be placed that way in ${container}.`,
  not_solo: (subject) => `${subject} holds more than one item, so it cannot merge into another.`,
  not_swappable: (subject) =>
    `${subject} has no place of its own to trade, so it cannot take that spot.`,
  not_displaceable: () =>
    "The note in that tile has nowhere else to live, so it cannot be displaced.",
  unknown_surface: () => "That item no longer exists.",
  unknown_container: () => "That container no longer exists.",
};

/**
 * The refusal for an item that is ALREADY classified — a live carry, local or a peer's.
 * The item travels with the carry, so the sentence never depends on the reader's census;
 * the lookup is here only to name the kind, which is the composition's answer, not the
 * carry's.
 */
export function itemDenialMessage(
  denial: PlacementDenial,
  item: PlacementItem,
  lookup: ItemLookup,
): string {
  return DENIAL_PROSE[denial.rule](lookup.noun(item.kind), CONTAINER_NOUN[denial.container.kind]);
}

/**
 * The same refusal when only the SURFACE is known: the server's answer to a `place` call
 * names a surface, and the caller reading it is the one who made the call, so classifying
 * it against that caller's own lookup is the right resolution. An unclassifiable surface
 * says "That item" rather than inventing a species.
 */
export function denialMessage(denial: PlacementDenial, lookup: ItemLookup): string {
  const item = placementItemFor(denial.surface, lookup);
  const subject = item === null ? "That item" : lookup.noun(item.kind);
  return DENIAL_PROSE[denial.rule](subject, CONTAINER_NOUN[denial.container.kind]);
}

/** What a carry would do at one destination: nothing to say, allowed, or refused. */
export interface ItemDropAssessment {
  /** The surface that was judged — the live carry's, or a peer's, as asked. */
  readonly surface: PlacementSurface;
  /** Null when the placement is legal. */
  readonly denial: PlacementDenial | null;
  /** Prose for the refusal; null when legal. */
  readonly message: string | null;
}

/**
 * What a refusing target wears. `data-drop-denial` carries the declared rule so the one
 * CSS cue in the stylesheet paints every target the same way, and the title carries both
 * the prose and the rule — the rule is the contract, the prose is the courtesy.
 */
export interface RefusalProps {
  readonly "data-drop-denial"?: string;
  readonly title?: string;
}

export interface UseItemDropOptions {
  readonly lookup: ItemLookup;
  /** The placement transport: a room client's `place`, or the token-bound HTTP helper. */
  readonly place: (
    surface: PlacementSurface,
    destination: PlacementDestination,
  ) => Promise<PlaceOutcome>;
  readonly notify: (message: string) => void;
  /** Ran after a placement lands, for callers that refetch rows or pools. */
  readonly onPlaced?: (result: PlaceResponse, envelope: ItemEnvelope) => void;
}

export interface ItemDropApi {
  /**
   * Legality of a carry at `destination`, defaulting to whatever this browser is holding;
   * null when there is nothing to judge.
   *
   * The carry is a parameter because legality is not the local dragger's privilege: a
   * preview of a PEER's aim has to answer the same question about the peer's carry, or
   * every collaborator paints a legal-looking cue over a drop the server will refuse —
   * and glides panes for it. What it takes is the WIRE form (surface + item), because a
   * watcher must never re-resolve an address: the producer already did, and asking a
   * watcher's own index poll the same question is how a legal drag came to read "That
   * item no longer exists." on every browser but the dragger's.
   */
  readonly assess: (
    destination: PlacementDestination,
    carried?: CarriedItem,
  ) => ItemDropAssessment | null;
  readonly refusalProps: (assessment: ItemDropAssessment | null | undefined) => RefusalProps;
  /**
   * Releases the carry into `destination`. A refusal the client can already see is
   * reported without a request; anything else goes to the executor, whose denial is
   * reported verbatim — so a rule the browser has not heard of still reads correctly.
   */
  readonly commit: (transfer: DataTransfer | null, destination: PlacementDestination) => void;
}

export function useItemDrop({ lookup, place, notify, onPlaced }: UseItemDropOptions): ItemDropApi {
  const assess = useCallback(
    (destination: PlacementDestination, carried?: CarriedItem): ItemDropAssessment | null => {
      const held = carried ?? carriedPlacement();
      if (held === null) return null;
      const resolution = resolveCarriedPlacement(held, destination, lookup);
      if (resolution.ok) return { surface: held.surface, denial: null, message: null };
      return {
        surface: held.surface,
        denial: resolution.denial,
        message: itemDenialMessage(resolution.denial, held.item, lookup),
      };
    },
    [lookup],
  );

  const refusalProps = useCallback(
    (assessment: ItemDropAssessment | null | undefined): RefusalProps => {
      if (assessment?.denial == null) return {};
      return {
        "data-drop-denial": assessment.denial.rule,
        title: `${assessment.message ?? ""} (rule: ${assessment.denial.rule})`,
      };
    },
    [],
  );

  const commit = useCallback(
    (transfer: DataTransfer | null, destination: PlacementDestination): void => {
      const envelope = readEnvelope(transfer);
      // Not one of our drags: staying silent is correct, the gesture was never ours.
      if (envelope === null) return;
      const surface = envelopeSurface(envelope);
      const resolution = resolvePlacement(surface, destination, lookup);
      if (!resolution.ok) {
        notify(denialMessage(resolution.denial, lookup));
        return;
      }
      void place(surface, destination)
        .then((outcome) => {
          if (outcome.ok) {
            onPlaced?.(outcome.result, envelope);
            return;
          }
          notify(denialMessage(outcome.denial, lookup));
        })
        .catch((reason: unknown) => {
          notify(reason instanceof Error ? reason.message : "That item could not be placed.");
        });
    },
    [lookup, notify, onPlaced, place],
  );

  return useMemo(() => ({ assess, refusalProps, commit }), [assess, refusalProps, commit]);
}
