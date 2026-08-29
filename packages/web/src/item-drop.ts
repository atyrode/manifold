import {
  placementItemFor,
  resolvePlacement,
  type ContainerLayout,
  type ContainerKind,
  type ItemKind,
  type Pad,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementDestination,
  type PlacementLookup,
  type PlacementSurface,
  type SceneElement,
} from "@manifold/protocol";
import type { PlaceOutcome } from "@manifold/sdk";
import { useCallback, useMemo } from "react";
import { carriedItem, envelopeSurface, readEnvelope, type ItemEnvelope } from "./item-envelope.ts";

/**
 * THE drop pipeline. Every destination in the application — the canvas pane, a canvas
 * node, a composition's tile leaf, a sidebar container row, the terminal pool — registers
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
 */

/** Prose per item kind. The rule is machine-readable; this is what a person reads. */
const ITEM_NOUN: Record<ItemKind, string> = {
  terminal: "A terminal",
  "canvas-pad": "A canvas",
  view: "A composition",
  text: "A note",
  draw: "A stroke",
  tile: "A tile",
};

/** Prose per container kind, in the object position of every refusal sentence. */
const CONTAINER_NOUN: Record<ContainerKind, string> = {
  canvas: "a canvas",
  view: "a composition",
  pool: "the terminal pool",
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
}

export function createPlacementLookup(inputs: PlacementLookupInputs): PlacementLookup {
  const layoutOf = (padId: string): ContainerLayout | null => {
    if (inputs.self?.padId === padId) return inputs.self.layout;
    return inputs.pads.find((pad) => pad.id === padId)?.layout ?? null;
  };
  return {
    padLayout: layoutOf,
    elementItem: (padId, elementId) => {
      // Only this renderer's own document is visible from here. Another container's
      // elements are not knowable without a socket, and no gesture addresses them.
      if (inputs.self?.padId !== padId) return null;
      const element = inputs.elements.get(elementId);
      if (element === undefined) return null;
      switch (element.type) {
        case "terminal":
          return { kind: "terminal", containerId: null };
        case "portal": {
          // A portal places the container it points at, so THAT container's discipline
          // decides the kind — and a portal onto an unknown container places nothing.
          const layout = layoutOf(element.containerId);
          if (layout === null) return null;
          return {
            kind: layout === "canvas" ? "canvas-pad" : "view",
            containerId: element.containerId,
          };
        }
        case "text":
          return { kind: "text", containerId: null };
        case "draw":
          return { kind: "draw", containerId: null };
        default: {
          const exhaustive: never = element;
          return exhaustive;
        }
      }
    },
  };
}

/**
 * A refusal in prose, derived from the declared rule and the two nouns involved. There is
 * one sentence per rule and no table of pairs: the rule already says WHY, so growing the
 * vocabulary of items or containers never grows this function.
 */
export function denialMessage(denial: PlacementDenial, lookup: PlacementLookup): string {
  const item = placementItemFor(denial.surface, lookup);
  const subject = item === null ? "That item" : ITEM_NOUN[item.kind];
  const container = CONTAINER_NOUN[denial.container.kind];
  switch (denial.rule) {
    case "not_accepted":
      return `${subject} does not go in ${container}.`;
    case "self_embed":
      return `${subject} cannot be placed inside itself.`;
    case "discipline":
      return `${subject} cannot be placed that way in ${container}.`;
    case "unknown_surface":
      return "That item no longer exists.";
    case "unknown_container":
      return "That container no longer exists.";
    default: {
      const exhaustive: never = denial.rule;
      return exhaustive;
    }
  }
}

/** What the live carry would do at one destination: nothing to say, allowed, or refused. */
export interface ItemDropAssessment {
  readonly envelope: ItemEnvelope;
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
  readonly lookup: PlacementLookup;
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
  /** Legality of the live carry at `destination`; null when nothing is being carried. */
  readonly assess: (destination: PlacementDestination) => ItemDropAssessment | null;
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
    (destination: PlacementDestination): ItemDropAssessment | null => {
      const envelope = carriedItem();
      if (envelope === null) return null;
      const resolution = resolvePlacement(envelopeSurface(envelope), destination, lookup);
      if (resolution.ok) return { envelope, denial: null, message: null };
      return {
        envelope,
        denial: resolution.denial,
        message: denialMessage(resolution.denial, lookup),
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
