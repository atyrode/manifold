import type {
  CarriedItem,
  ContainerLayout,
  PlacementItem,
  PlacementSurface,
} from "@manifold/protocol";

/**
 * THE transfer envelope. One mime, one typed payload, for every drag in the application
 * that means "put this item there".
 *
 * Before this module there were four mimes, each a bare id string or ad-hoc JSON, parsed
 * by hand at every drop target — which is why a container dropped on bare canvas and a
 * terminal dropped on a composition row were silent no-ops: nothing structurally forced a
 * target to handle a kind it had not been written for. Here the payload names its kind,
 * and `envelopeSurface` turns it into the protocol's `PlacementSurface`, so a target
 * consults ONE policy (`resolvePlacement`) instead of growing a branch per source.
 *
 * The kinds follow the product vocabulary: a view is the genus, a CANVAS is the freeform
 * species and a COMPOSITION the tiled one. Both are the same stored object (`Pad`), so
 * both map to the same surface form — the discipline is carried in the kind because a
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
 * a multi-placed session — or a note, which has no identity outside its document — becomes
 * addressable.
 */
export type ItemEnvelope =
  | { readonly kind: "terminal"; readonly sessionId: string }
  | { readonly kind: "canvas"; readonly padId: string }
  | { readonly kind: "composition"; readonly padId: string }
  | { readonly kind: "tile"; readonly containerId: string; readonly tileId: string }
  | { readonly kind: "element"; readonly padId: string; readonly elementId: string };

export type ItemEnvelopeKind = ItemEnvelope["kind"];

/** A container's envelope, with its discipline decided by the row the drag came from. */
export function containerEnvelope(padId: string, layout: ContainerLayout): ItemEnvelope {
  return layout === "tiled" ? { kind: "composition", padId } : { kind: "canvas", padId };
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
      const sessionId = nonEmptyString(record["sessionId"]);
      return sessionId === null ? null : { kind: "terminal", sessionId };
    }
    case "canvas": {
      const padId = nonEmptyString(record["padId"]);
      return padId === null ? null : { kind: "canvas", padId };
    }
    case "composition": {
      const padId = nonEmptyString(record["padId"]);
      return padId === null ? null : { kind: "composition", padId };
    }
    case "tile": {
      const containerId = nonEmptyString(record["containerId"]);
      const tileId = nonEmptyString(record["tileId"]);
      return containerId === null || tileId === null ? null : { kind: "tile", containerId, tileId };
    }
    case "element": {
      const padId = nonEmptyString(record["padId"]);
      const elementId = nonEmptyString(record["elementId"]);
      return padId === null || elementId === null ? null : { kind: "element", padId, elementId };
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
interface LiveCarry extends CarriedItem {
  readonly envelope: ItemEnvelope;
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
let watchingDragEnd = false;

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
  carried = { envelope, surface: envelopeSurface(envelope), item };
}

export function endCarry(): void {
  carried = null;
}

/** The envelope in hand: the addressing form the drag's zone logic reads. */
export function carriedItem(): ItemEnvelope | null {
  return carried?.envelope ?? null;
}

/** What is in hand, resolved — the local half of what a peer receives on the wire. */
export function carriedPlacement(): CarriedItem | null {
  return carried === null ? null : { surface: carried.surface, item: carried.item };
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

/** The minimal surface of a drag event this module needs; React's synthetic event fits. */
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
 * The envelope as the protocol sees it. Both container kinds collapse to one surface form
 * on purpose: the server resolves a container's discipline from its own row, so a client
 * can never assert a discipline it does not have.
 */
export function envelopeSurface(envelope: ItemEnvelope): PlacementSurface {
  switch (envelope.kind) {
    case "terminal":
      return { kind: "terminal", sessionId: envelope.sessionId };
    case "canvas":
    case "composition":
      return { kind: "pad", padId: envelope.padId };
    case "tile":
      return { kind: "tile", containerId: envelope.containerId, tileId: envelope.tileId };
    case "element":
      return { kind: "element", padId: envelope.padId, elementId: envelope.elementId };
    default: {
      const exhaustive: never = envelope;
      return exhaustive;
    }
  }
}
