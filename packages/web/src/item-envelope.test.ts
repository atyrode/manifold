import { afterEach, describe, expect, test } from "bun:test";
import {
  ITEM_MIME,
  beginCarry,
  carriedItem,
  carriesItem,
  containerEnvelope,
  endCarry,
  envelopeSurface,
  parseEnvelope,
  readEnvelope,
  sealEnvelope,
  startItemDrag,
  validateEnvelope,
  type ItemEnvelope,
  type ItemEnvelopeKind,
} from "./item-envelope.ts";

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
  terminal: { kind: "terminal", sessionId: "s1" },
  canvas: { kind: "canvas", padId: "c1" },
  composition: { kind: "composition", padId: "v1" },
  tile: { kind: "tile", containerId: "v1", tileId: "t3" },
  element: { kind: "element", padId: "c1", elementId: "e7" },
};

afterEach(() => endCarry());

describe("envelope format", () => {
  test("every kind round-trips through the wire payload", () => {
    for (const envelope of Object.values(ENVELOPES)) {
      expect(parseEnvelope(sealEnvelope(envelope))).toEqual(envelope);
    }
  });

  test("every kind maps to exactly one placement surface", () => {
    expect(envelopeSurface(ENVELOPES.terminal)).toEqual({ kind: "terminal", sessionId: "s1" });
    // Both container species place through ONE surface form: the server resolves the
    // discipline from its own row, so a client can never assert one.
    expect(envelopeSurface(ENVELOPES.canvas)).toEqual({ kind: "pad", padId: "c1" });
    expect(envelopeSurface(ENVELOPES.composition)).toEqual({ kind: "pad", padId: "v1" });
    expect(envelopeSurface(ENVELOPES.tile)).toEqual({
      kind: "tile",
      containerId: "v1",
      tileId: "t3",
    });
    expect(envelopeSurface(ENVELOPES.element)).toEqual({
      kind: "element",
      padId: "c1",
      elementId: "e7",
    });
  });

  test("a container's discipline decides its kind", () => {
    expect(containerEnvelope("p1", "canvas")).toEqual({ kind: "canvas", padId: "p1" });
    expect(containerEnvelope("p1", "tiled")).toEqual({ kind: "composition", padId: "p1" });
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
      '{"kind":"terminal","sessionId":""}',
      '{"kind":"canvas"}',
      '{"kind":"tile","containerId":"v1"}',
      '{"kind":"element","padId":"c1"}',
    ]) {
      expect(parseEnvelope(payload)).toBeNull();
    }
    expect(validateEnvelope(undefined)).toBeNull();
    expect(validateEnvelope(42)).toBeNull();
  });

  test("extra fields are ignored rather than rejected, so the payload can grow", () => {
    expect(parseEnvelope('{"kind":"terminal","sessionId":"s1","label":"build"}')).toEqual({
      kind: "terminal",
      sessionId: "s1",
    });
  });
});

describe("drag transfer", () => {
  test("a sealed drag advertises the one mime and carries its payload", () => {
    const dataTransfer = transfer();
    startItemDrag({ dataTransfer }, ENVELOPES.composition);
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
    sealEnvelope(ENVELOPES.canvas);
    // This is what makes dragover legality possible: the spec hides getData until drop.
    expect(carriedItem()).toEqual(ENVELOPES.canvas);
    endCarry();
    expect(carriedItem()).toBeNull();
  });

  test("a carry without a transfer is readable at drop, and the wire payload wins", () => {
    beginCarry(ENVELOPES.element);
    expect(readEnvelope(null)).toEqual(ENVELOPES.element);
    expect(readEnvelope(transfer({ [ITEM_MIME]: JSON.stringify(ENVELOPES.terminal) }))).toEqual(
      ENVELOPES.terminal,
    );
  });

  test("an empty payload under our own mime falls back to the live carry", () => {
    beginCarry(ENVELOPES.tile);
    expect(readEnvelope(transfer({ [ITEM_MIME]: "" }))).toEqual(ENVELOPES.tile);
  });
});
