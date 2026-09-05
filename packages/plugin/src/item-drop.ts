import {
  elementString,
  placementItemFor,
  resolveCarriedPlacement,
  resolvePlacement,
  rosterDisciplines,
  type CarriedItem,
  type ContainerDiscipline,
  type Container,
  type PlacementContainer,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementRef,
  type PluginRoster,
  type SceneElement,
} from "@manifold/protocol";
import { rosterElementTraits } from "./assemble.ts";
import { itemNounPhrase } from "./item-noun.ts";
import type { PlaceOutcome } from "./host.ts";
import { useCallback, useMemo } from "react";
import { carriedPlacement, envelopeRef, readEnvelope, type ItemEnvelope } from "./item-envelope.ts";

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
 * Prose for the container a refusal names, in the object position of every refusal
 * sentence. It is DERIVED from the one label vocabulary rather than written again: a
 * container is an item seen from the other side, so it takes the word its DISCIPLINE
 * declared and `unplaced` gets a sentence of its own — it is not a place, so it reads as
 * the one thing it actually is, the index's top level, where an item that nothing
 * references sits.
 *
 * The discipline, not the destination FORM's container family: the family is closed wire
 * vocabulary (`canvas`, `composition`, `unplaced`) and the roster is open. A container
 * the census does not know is named by its id, never by a kind inferred from the
 * destination form. A known `spreadsheet` container refuses as "a spreadsheet"; a
 * container whose discipline nothing declares reads as "an item", `itemNoun`'s truthful
 * generic and exactly what the sentence for `unknown_discipline` is about.
 */
function containerNoun(container: PlacementContainer, lookup: ItemLookup): string {
  if (container.kind === "unplaced") return "the index";
  // `noun` answers in the SUBJECT position ("A canvas"); an object position wants the
  // same phrase uncapitalised, and the article is already the right one.
  const discipline = lookup.disciplineOf(container.containerId);
  if (discipline === null) return `container ${container.containerId}`;
  const phrase = lookup.noun(discipline);
  return phrase.charAt(0).toLowerCase() + phrase.slice(1);
}

/**
 * State the algebra asks about, answered from what this renderer already holds: the
 * container index the sidebar fetched, the container this renderer IS, and its live
 * elements. The server answers the same two questions from its rows and rooms, which is
 * the whole reason a preview and the write it precedes cannot drift.
 */
export interface PlacementLookupInputs {
  /** Every container the sidebar indexes; a drag source is always one of these. */
  readonly containers: readonly Container[];
  /** The container being rendered, whose row may not have arrived yet (a newborn view). */
  readonly self: { readonly containerId: string; readonly discipline: ContainerDiscipline } | null;
  /** Live elements of `self`; empty for a composition, which places no elements freely. */
  readonly elements: ReadonlyMap<string, SceneElement>;
  /**
   * The composition each terminal lives in. Every terminal has one from birth, so a miss
   * here means no such terminal — a denial, never a terminal without a home.
   */
  readonly terminalHomes: ReadonlyMap<string, string>;
  /**
   * What a container holds when it holds exactly ONE item. This is the whole of
   * "compositions merge, never nest": placement looks THROUGH a solo composition to its
   * occupant, so a canvas portal onto a lone terminal drags as that terminal. Absent for
   * a container this ref has no census of, which denies `not_solo` rather than
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
  const disciplineOf = (containerId: string): ContainerDiscipline | null => {
    if (inputs.self?.containerId === containerId) return inputs.self.discipline;
    return inputs.containers.find((container) => container.id === containerId)?.discipline ?? null;
  };
  const traits = rosterElementTraits(inputs.roster);
  const disciplines = rosterDisciplines(inputs.roster);
  return {
    disciplineOf: disciplineOf,
    discipline: (id) => disciplines.get(id) ?? null,
    elementItem: (containerId, elementId) => {
      // Only this renderer's own document is visible from here. Another container's
      // elements are not knowable without a socket, and no gesture addresses them.
      if (inputs.self?.containerId !== containerId) return null;
      const element = inputs.elements.get(elementId);
      if (element === undefined) return null;
      if (element.type === "portal") {
        // A portal places the container it points at, so THAT container's discipline
        // decides the kind — and a portal onto an unknown container places nothing.
        // A terminal on a canvas IS this case: its portal points at its home.
        //
        // The target is read through `elementString` because the protocol's element schema is
        // a neutral envelope now (ADR 0013 §16): the payload is bounded, not interpreted, so a
        // portal missing its own reference is a `null` to refuse on rather than a field to
        // trust. That is the same refusal as a portal onto a container nobody indexed.
        const target = elementString(element, "containerId");
        const discipline = target === null ? null : disciplineOf(target);
        if (discipline === null) return null;
        return {
          kind: discipline,
          containerId: target,
        };
      }
      // Every other element PLACES ITS OWN TYPE, and the traits that decide its legality
      // arrive with the type from the roster. No arm per element kind: that switch was the
      // engine learning a plugin's name (§12).
      return { kind: element.type, containerId: null };
    },
    terminalHome: (terminalId) => inputs.terminalHomes.get(terminalId) ?? null,
    soloOccupant: (containerId) => inputs.soloOccupants.get(containerId) ?? null,
    itemTraits: (kind) => traits.get(kind) ?? null,
    noun: (kind) => itemNounPhrase(kind, inputs.roster),
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
  unknown_ref: () => "That item no longer exists.",
  unknown_container: (_subject, container) => `${container.charAt(0).toUpperCase() + container.slice(1)} is not known to this workspace.`,
  /*
    The container is there and its renderer is not (#110). The sentence names the RENDERER
    rather than the container, because the container is fine — this build simply has no
    plugin that reads its discipline, and the `unknown_container` sentence would be a lie
    a principal would act on by recreating something they already have.
  */
  unknown_discipline: (subject, container) =>
    `${subject} cannot go in ${container}: nothing here knows how to render it.`,
  no_tree: (subject) => `${subject} only goes into an arrangement that already exists.`,
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
  return DENIAL_PROSE[denial.rule](lookup.noun(item.kind), containerNoun(denial.container, lookup));
}

/**
 * The same refusal when only the REF is known: the server's answer to a `place` call
 * names a ref, and the caller reading it is the one who made the call, so classifying
 * it against that caller's own lookup is the right resolution. An unclassifiable ref
 * says "That item" rather than inventing a species.
 */
export function denialMessage(denial: PlacementDenial, lookup: ItemLookup): string {
  const item = placementItemFor(denial.ref, lookup);
  const subject = item === null ? "That item" : lookup.noun(item.kind);
  return DENIAL_PROSE[denial.rule](subject, containerNoun(denial.container, lookup));
}

/** What a carry would do at one destination: nothing to say, allowed, or refused. */
export interface ItemDropAssessment {
  /** The ref that was judged — the live carry's, or a peer's, as asked. */
  readonly ref: PlacementRef;
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
  readonly place: (ref: PlacementRef, destination: PlacementDestination) => Promise<PlaceOutcome>;
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
   * and glides panes for it. What it takes is the WIRE form (ref + item), because a
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
      if (resolution.ok) return { ref: held.ref, denial: null, message: null };
      return {
        ref: held.ref,
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
      const ref = envelopeRef(envelope);
      const resolution = resolvePlacement(ref, destination, lookup);
      if (!resolution.ok) {
        notify(denialMessage(resolution.denial, lookup));
        return;
      }
      void place(ref, destination)
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
