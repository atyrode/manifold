import { StructureSchema } from "@manifold/protocol";
import type {
  CarriedItem,
  CarryAim,
  ContainerDiscipline,
  PlacementItem,
  PlacementRef,
  Structure,
} from "@manifold/protocol";

/**
 * THE transfer envelope. One mime, one typed payload, for every drag in the application
 * that means "put this item there".
 *
 * Before this module there were four mimes, each a bare id string or ad-hoc JSON, parsed
 * by hand at every drop target — which is why a container dropped on bare canvas and a
 * terminal dropped on a composition row were silent no-ops: nothing structurally forced a
 * target to handle a kind it had not been written for. Here the payload names its kind,
 * and `envelopeRef` turns it into the protocol's `PlacementRef`, so a target
 * consults ONE policy (`resolvePlacement`) instead of growing a branch per source.
 *
 * The kinds follow the product vocabulary: a view is the genus, a CANVAS is the freeform
 * species and a COMPOSITION the composed one. Both are the same stored object (`Container`), so
 * both map to the same ref form — the discipline is carried in the kind because a
 * drag preview has to answer "is this tileable here?" without a round trip.
 *
 * One thing is NOT a placement and deliberately keeps its own mime: headless-tree's
 * internal sibling reorders, which order rows inside one index and name no container
 * relationship at all.
 *
 * It lives in the ENGINE because both sides of the boundary drag the same items: the
 * canvas and composition renderers are floor, the workspace index that drags a container
 * row into a tile is a plugin, and neither may import the other. A second envelope format
 * for the plugin side would be exactly the per-source parsing this module exists to end
 * (AGENTS.md invariant 14). The browser half of `@manifold/plugin` carries it because the
 * carry register below is DOM-bound; the server never sees a drag.
 */
export const ITEM_MIME = "application/x-manifold-item";

/**
 * What is being carried. `terminal`, `canvas` and `composition` name an ITEM by identity;
 * `tile` and `element` name an existing PLACEMENT of one, which is how a single mirror of
 * a multi-placed terminal — or a note, which has no identity outside its document — becomes
 * addressable. `structure` names NOTHING YET: it is what a palette drag holds, and the
 * shape it carries is authored by the drop (issue #104).
 *
 * A palette item is a carry SOURCE like any other precisely because it seals one of these:
 * the same mime, the same register, the same wire ref, the same three verbs on
 * `useCarry`. What differs is only where a release can legally put it, and that is the
 * placement algebra's answer (`ITEM_KINDS.structure`), never a second transport.
 */
export type ItemEnvelope =
  | { readonly kind: "terminal"; readonly terminalId: string }
  | { readonly kind: "canvas"; readonly containerId: string }
  | { readonly kind: "composition"; readonly containerId: string }
  | { readonly kind: "tile"; readonly containerId: string; readonly tileId: string }
  | { readonly kind: "element"; readonly containerId: string; readonly elementId: string }
  | { readonly kind: "structure"; readonly structure: Structure };

export type ItemEnvelopeKind = ItemEnvelope["kind"];

/** A container's envelope, with its discipline decided by the row the drag came from. */
export function containerEnvelope(
  containerId: string,
  discipline: ContainerDiscipline,
): ItemEnvelope {
  return discipline === "composition"
    ? { kind: "composition", containerId }
    : { kind: "canvas", containerId };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Validates an untrusted value into an envelope, or null. Hand-rolled rather than schema
 * driven because this shape never crosses a process boundary — it crosses a DataTransfer,
 * where the only hostile input is another application's payload under our own mime.
 */
export function validateEnvelope(value: unknown): ItemEnvelope | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record["kind"]) {
    case "terminal": {
      const terminalId = nonEmptyString(record["terminalId"]);
      return terminalId === null ? null : { kind: "terminal", terminalId };
    }
    case "canvas": {
      const containerId = nonEmptyString(record["containerId"]);
      return containerId === null ? null : { kind: "canvas", containerId };
    }
    case "composition": {
      const containerId = nonEmptyString(record["containerId"]);
      return containerId === null ? null : { kind: "composition", containerId };
    }
    case "tile": {
      const containerId = nonEmptyString(record["containerId"]);
      const tileId = nonEmptyString(record["tileId"]);
      return containerId === null || tileId === null ? null : { kind: "tile", containerId, tileId };
    }
    case "element": {
      const containerId = nonEmptyString(record["containerId"]);
      const elementId = nonEmptyString(record["elementId"]);
      return containerId === null || elementId === null
        ? null
        : { kind: "element", containerId, elementId };
    }
    /*
      The one payload with no id in it, so the SHAPE is all there is to validate — and
      `StructureSchema` is the definition of that shape, so it does the validating rather
      than a second hand-rolled copy of the same two cases drifting beside it.
    */
    case "structure": {
      const structure = StructureSchema.safeParse(record["structure"]);
      return structure.success ? { kind: "structure", structure: structure.data } : null;
    }
    default:
      return null;
  }
}

/** Parses a raw payload; anything malformed is simply not one of our drags. */
export function parseEnvelope(payload: string): ItemEnvelope | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  return validateEnvelope(parsed);
}

/** The register's own record: the addressing form plus the two resolved wire fields. */
export interface LiveCarry extends CarriedItem {
  readonly envelope: ItemEnvelope;
  readonly aim?: CarryAim | undefined;
}

/**
 * The item under the cursor right now, and what it IS.
 *
 * This register exists because the HTML5 spec hides `getData` during `dragover`: a target
 * can see the MIME TYPES of a drag but not its payload until release. With one mime that
 * would leave every preview blind, so the source records what it is carrying the moment
 * the gesture starts and the pipeline reads it back for legality. The payload on the
 * DataTransfer stays authoritative at drop, which is what keeps a drag from another window
 * (or a future external source) working without this register at all.
 *
 * It holds the RESOLVED item beside the envelope, and that is the whole point of resolving
 * at the grab: the source is the one party guaranteed to know what it grabbed. Every
 * consumer downstream — this browser's own previews and every collaborator's, which read
 * the same value off the wire (`Carry.item`) — judges legality from the item instead of
 * re-deriving it from an address against a census it may not have yet.
 */
let carried: LiveCarry | null = null;
let placementSnapshot: CarriedItem | null = null;
let watchingDragEnd = false;
const carryListeners = new Set<() => void>();

/** Stable snapshot for source projection; the same register drives drop legality. */
export function carriedSnapshot(): LiveCarry | null {
  return carried;
}

export function subscribeCarry(listener: () => void): () => void {
  carryListeners.add(listener);
  return () => {
    carryListeners.delete(listener);
  };
}

function notifyCarry(): void {
  for (const listener of carryListeners) listener();
}

/** Called by the carry transport only when its normalized aim changes. */
export function updateCarryAim(aim: CarryAim | undefined): void {
  if (carried === null || carried.aim === aim) return;
  carried = { ...carried, aim };
  notifyCarry();
}

/**
 * `dragend` always fires on the source, including on an aborted drag, so it is the one
 * event that reliably ends a carry. Registered once, in capture phase, and never removed:
 * the register is module state and the listener is its lifetime.
 *
 * The guard tests the CAPABILITY rather than the global: a headless test runtime can expose
 * a `window` that carries no event target, and the format half of this module has to keep
 * working there — the carry is a browser affordance, not part of the payload contract.
 */
function watchDragEnd(): void {
  if (watchingDragEnd) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  watchingDragEnd = true;
  window.addEventListener("dragend", () => endCarry(), true);
}

/**
 * Starts a carry that is not backed by a DataTransfer (a React Flow node drag). The item
 * is a parameter, not a lookup, because only the grab site can answer it without a census.
 */
export function beginCarry(envelope: ItemEnvelope, item: PlacementItem): void {
  watchDragEnd();
  placementSnapshot = { ref: envelopeRef(envelope), item };
  carried = { envelope, ...placementSnapshot };
  notifyCarry();
}

export function endCarry(): void {
  if (carried === null) return;
  carried = null;
  placementSnapshot = null;
  notifyCarry();
}

/** The envelope in hand: the addressing form the drag's zone logic reads. */
export function carriedItem(): ItemEnvelope | null {
  return carried?.envelope ?? null;
}

/** What is in hand, resolved — the local half of what a peer receives on the wire. */
export function carriedPlacement(): CarriedItem | null {
  return placementSnapshot;
}

/**
 * Seals an envelope for the wire AND begins the carry, because they are the same event:
 * every source hands this string to its `dataTransfer.setData` (or to headless-tree's
 * `createForeignDragObject`, which is the only source shape that cannot run a handler).
 */
export function sealEnvelope(envelope: ItemEnvelope, item: PlacementItem): string {
  beginCarry(envelope, item);
  return JSON.stringify(envelope);
}

/** The minimal ref of a drag event this module needs; React's synthetic event fits. */
interface TransferEvent {
  readonly dataTransfer: DataTransfer;
}

/** Source-side `dragstart`: seal the payload and mark the gesture as a move. */
export function startItemDrag(
  event: TransferEvent,
  envelope: ItemEnvelope,
  item: PlacementItem,
): void {
  event.dataTransfer.setData(ITEM_MIME, sealEnvelope(envelope, item));
  event.dataTransfer.effectAllowed = "move";
}

/** True during `dragover` for one of our drags; the payload is still sealed here. */
export function carriesItem(transfer: DataTransfer): boolean {
  return transfer.types.includes(ITEM_MIME);
}

/**
 * The envelope at drop time: the wire payload first, the live carry as the fallback for
 * gestures that never had a DataTransfer.
 */
export function readEnvelope(transfer: DataTransfer | null): ItemEnvelope | null {
  if (transfer === null) return carriedItem();
  const payload = transfer.getData(ITEM_MIME);
  return payload === "" ? carriedItem() : parseEnvelope(payload);
}

/**
 * The envelope as the protocol sees it. Both container kinds collapse to one ref form
 * on purpose: the server resolves a container's discipline from its own row, so a client
 * can never assert a discipline it does not have.
 */
export function envelopeRef(envelope: ItemEnvelope): PlacementRef {
  switch (envelope.kind) {
    case "terminal":
      return { kind: "terminal", terminalId: envelope.terminalId };
    case "canvas":
    case "composition":
      return { kind: "container", containerId: envelope.containerId };
    case "tile":
      return { kind: "tile", containerId: envelope.containerId, tileId: envelope.tileId };
    case "element":
      return { kind: "element", containerId: envelope.containerId, elementId: envelope.elementId };
    case "structure":
      return { kind: "structure", structure: envelope.structure };
    default: {
      const exhaustive: never = envelope;
      return exhaustive;
    }
  }
}
