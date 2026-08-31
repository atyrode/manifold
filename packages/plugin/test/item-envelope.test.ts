import { afterEach, describe, expect, test } from "bun:test";
import type { PlacementItem } from "@manifold/protocol";
import {
  ITEM_MIME,
  beginCarry,
  carriedItem,
  carriedPlacement,
  carriesItem,
  containerEnvelope,
  endCarry,
  envelopeRef,
  parseEnvelope,
  readEnvelope,
  sealEnvelope,
  startItemDrag,
  validateEnvelope,
  type ItemEnvelope,
  type ItemEnvelopeKind,
} from "../src/item-envelope.ts";

/**
 * A DataTransfer stand-in. Bun's test environment has no DOM, and the envelope only ever
 * touches three members of the real thing — which is exactly why the module takes the
 * transfer rather than the event.
 */
function transfer(entries: Readonly<Record<string, string>> = {}): DataTransfer {
  const data = new Map<string, string>(Object.entries(entries));
  return {
    get types(): readonly string[] {
      return [...data.keys()];
    },
    effectAllowed: "none",
    getData: (format: string) => data.get(format) ?? "",
    setData: (format: string, value: string) => {
      data.set(format, value);
    },
  } as unknown as DataTransfer;
}

/** One envelope per declared kind: a new kind cannot compile without a case here. */
const ENVELOPES: Readonly<Record<ItemEnvelopeKind, ItemEnvelope>> = {
  terminal: { kind: "terminal", terminalId: "s1" },
  canvas: { kind: "canvas", containerId: "c1" },
  composition: { kind: "composition", containerId: "v1" },
  tile: { kind: "tile", containerId: "v1", tileId: "t3" },
  element: { kind: "element", containerId: "c1", elementId: "e7" },
};

/**
 * The item each envelope resolves to at its grab site. A carry names what it holds because
 * only the grabber can classify it without a census — these are the answers a real grab
 * site computes from its own lookup.
 */
const ITEMS: Readonly<Record<ItemEnvelopeKind, PlacementItem>> = {
  terminal: { kind: "terminal", containerId: "home-1" },
  canvas: { kind: "canvas", containerId: "c1" },
  composition: { kind: "composition", containerId: "v1" },
  tile: { kind: "tile", containerId: null },
  element: { kind: "text", containerId: null },
};

afterEach(() => endCarry());

describe("envelope format", () => {
  test("every kind round-trips through the wire payload", () => {
    for (const envelope of Object.values(ENVELOPES)) {
      expect(parseEnvelope(sealEnvelope(envelope, ITEMS[envelope.kind]))).toEqual(envelope);
    }
  });

  test("every kind maps to exactly one placement ref", () => {
    expect(envelopeRef(ENVELOPES.terminal)).toEqual({ kind: "terminal", terminalId: "s1" });
    // Both container species place through ONE ref form: the server resolves the
    // discipline from its own row, so a client can never assert one.
    expect(envelopeRef(ENVELOPES.canvas)).toEqual({ kind: "container", containerId: "c1" });
    expect(envelopeRef(ENVELOPES.composition)).toEqual({ kind: "container", containerId: "v1" });
    expect(envelopeRef(ENVELOPES.tile)).toEqual({
      kind: "tile",
      containerId: "v1",
      tileId: "t3",
    });
    expect(envelopeRef(ENVELOPES.element)).toEqual({
      kind: "element",
      containerId: "c1",
      elementId: "e7",
    });
  });

  test("a container's discipline decides its kind", () => {
    expect(containerEnvelope("p1", "canvas")).toEqual({ kind: "canvas", containerId: "p1" });
    expect(containerEnvelope("p1", "composition")).toEqual({
      kind: "composition",
      containerId: "p1",
    });
  });

  test("malformed, foreign and incomplete payloads are not drags of ours", () => {
    for (const payload of [
      "",
      "not json",
      "null",
      "[]",
      '"terminal"',
      '{"kind":"browser","url":"x"}',
      '{"kind":"terminal"}',
      '{"kind":"terminal","terminalId":""}',
      '{"kind":"canvas"}',
      '{"kind":"tile","containerId":"v1"}',
      '{"kind":"element","containerId":"c1"}',
    ]) {
      expect(parseEnvelope(payload)).toBeNull();
    }
    expect(validateEnvelope(undefined)).toBeNull();
    expect(validateEnvelope(42)).toBeNull();
  });

  test("extra fields are ignored rather than rejected, so the payload can grow", () => {
    expect(parseEnvelope('{"kind":"terminal","terminalId":"s1","label":"build"}')).toEqual({
      kind: "terminal",
      terminalId: "s1",
    });
  });
});

describe("drag transfer", () => {
  test("a sealed drag advertises the one mime and carries its payload", () => {
    const dataTransfer = transfer();
    startItemDrag({ dataTransfer }, ENVELOPES.composition, ITEMS.composition);
    expect(carriesItem(dataTransfer)).toBe(true);
    expect(dataTransfer.types).toEqual([ITEM_MIME]);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(readEnvelope(dataTransfer)).toEqual(ENVELOPES.composition);
  });

  test("a foreign drag is not claimed", () => {
    const foreign = transfer({ "text/plain": "hello" });
    expect(carriesItem(foreign)).toBe(false);
    expect(readEnvelope(foreign)).toBeNull();
  });
});

describe("carry register", () => {
  test("sealing a payload begins the carry, because they are one event", () => {
    expect(carriedItem()).toBeNull();
    sealEnvelope(ENVELOPES.canvas, ITEMS.canvas);
    // This is what makes dragover legality possible: the spec hides getData until drop.
    expect(carriedItem()).toEqual(ENVELOPES.canvas);
    endCarry();
    expect(carriedItem()).toBeNull();
  });

  test("the carry holds the resolved item, which is what a peer receives", () => {
    expect(carriedPlacement()).toBeNull();
    beginCarry(ENVELOPES.composition, ITEMS.composition);
    // Ref AND item: the address to place, and what it names. A watcher gets both, so
    // nothing downstream re-derives an item from a census it may not have yet.
    expect(carriedPlacement()).toEqual({
      ref: { kind: "container", containerId: "v1" },
      item: { kind: "composition", containerId: "v1" },
    });
    endCarry();
    expect(carriedPlacement()).toBeNull();
  });

  test("a carry without a transfer is readable at drop, and the wire payload wins", () => {
    beginCarry(ENVELOPES.element, ITEMS.element);
    expect(readEnvelope(null)).toEqual(ENVELOPES.element);
    expect(readEnvelope(transfer({ [ITEM_MIME]: JSON.stringify(ENVELOPES.terminal) }))).toEqual(
      ENVELOPES.terminal,
    );
  });

  test("an empty payload under our own mime falls back to the live carry", () => {
    beginCarry(ENVELOPES.tile, ITEMS.tile);
    expect(readEnvelope(transfer({ [ITEM_MIME]: "" }))).toEqual(ENVELOPES.tile);
  });
});
