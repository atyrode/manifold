import { describe, expect, test } from "bun:test";
import { sillVariant } from "../scenes/sill/index.ts";
import { readElements } from "../state.ts";
import { ComposeError, composeScene, variantPreset } from "./compose.ts";
import {
  decodeElements,
  elementFeatures,
  ELEMENTS_KEY,
  encodeElements,
  LIGHT_CAP,
  WINDOW_CAP,
} from "./elements.ts";
import { interior } from "./interior.ts";
import type { LightElement } from "./types.ts";

// A room's light elements (ADR 0062 "Light elements", D17): one packed URL key read as `planets=` is,
// their kinds and count compiled in, at most LIGHT_CAP lights a program and one shadowing element.

const candle = (x: number): LightElement => ({
  kind: "candle",
  at: [x, 0, 1.25],
  colour: [1, 0.62, 0.3],
  power: 0.35,
  reach: 0.4,
  flicker: 0.6,
  shadow: false,
});

const composeWith = (elements: readonly LightElement[]) =>
  composeScene(interior, variantPreset(interior.baseline, { ...sillVariant, elements }));

describe("light elements", () => {
  test("a list round-trips through its URL value, on its centimetre and hundredth grids", () => {
    const window: LightElement = {
      kind: "window",
      at: [-1.1, 0.8, 1.05],
      colour: [0.85, 0.95, 1.2],
      power: 0.55,
      reach: 1,
      flicker: 0,
      shadow: true,
      window: { wall: "left", size: [0.42, 0.56], bars: [2, 2], sash: 0.3 },
    };
    const list = [window, candle(-0.31), { ...candle(0.2), kind: "neon" as const, shadow: true }];
    expect(decodeElements(encodeElements(list))).toEqual(list);
    expect(encodeElements([])).toBe("");
    expect(decodeElements("")).toEqual([]);
    expect(decodeElements("not base64!")).toEqual([]);
  });

  test("a link without the key holds the scene's elements, `elements=` none", () => {
    expect(readElements("sill", new URLSearchParams())).toEqual([...interior.baseline.elements]);
    expect(readElements("sill", new URLSearchParams(`${ELEMENTS_KEY}=`))).toEqual([]);
    const two = encodeElements([candle(0), candle(0.1)]);
    expect(readElements("sill", new URLSearchParams({ [ELEMENTS_KEY]: two }))).toHaveLength(2);
    // A scene without elements (outdoors) holds none whatever the link says.
    expect(readElements("meadow", new URLSearchParams({ [ELEMENTS_KEY]: two }))).toEqual([]);
  });

  test("kinds and count are compiled in", () => {
    expect(elementFeatures(interior.baseline.elements)).toEqual({
      ROOM_ELEMENTS: 2,
      ROOM_KIND_0: 8,
      ROOM_KIND_1: 1,
    });
  });

  test(`a program holds at most ${LIGHT_CAP} lights, checked when composed`, () => {
    const fill = Array.from({ length: LIGHT_CAP }, (_, k) => candle(-0.5 + 0.1 * k));
    expect(() => composeWith(fill)).not.toThrow();
    expect(() => composeWith([...fill, candle(0.4)])).toThrow(ComposeError);
    // The layers' declared lights count too: the lava lamp on the sill takes one.
    expect(() =>
      composeScene(
        interior,
        variantPreset(interior.baseline, {
          ...sillVariant,
          layers: { add: ["props", "cat", "curtain", "lavaLamp"] },
          elements: fill,
        }),
      ),
    ).toThrow(ComposeError);
  });

  test("at most one element throws shadows beside the World's key, and a screen waits", () => {
    expect(() => composeWith([{ ...candle(0), shadow: true }])).not.toThrow();
    expect(() =>
      composeWith([
        { ...candle(0), shadow: true },
        { ...candle(0.2), shadow: true },
      ]),
    ).toThrow(ComposeError);
    expect(() => composeWith([{ ...candle(0), kind: "screen" }])).toThrow(ComposeError);
  });

  test(`a program holds at most ${WINDOW_CAP} windows, and a link keeps the first that fit`, () => {
    const window = interior.baseline.elements[0];
    if (window?.kind !== "window") throw new Error("the baseline opens with its window");
    const side: LightElement = {
      ...window,
      at: [-1.6, 0.6, 1],
      window: { wall: "left", size: [0.8, 1], bars: [2, 2] },
    };
    const windows = Array.from({ length: WINDOW_CAP }, () => side);
    expect(() => composeWith(windows)).not.toThrow();
    expect(() => composeWith([...windows, side])).toThrow(ComposeError);
    const query = new URLSearchParams({
      [ELEMENTS_KEY]: encodeElements([
        ...windows,
        side,
        { ...candle(0), shadow: true },
        { ...candle(0.2), shadow: true },
        candle(0.4),
      ]),
    });
    expect(readElements("sill", query).map((e) => `${e.kind}${e.shadow ? "*" : ""}`)).toEqual([
      ...windows.map(() => "window*"),
      "candle*",
      "candle",
    ]);
    // A list longer than any program holds keeps its first: the sill has room for one light less
    // than LIGHT_CAP, the lava lamp it offers declaring one.
    const many = encodeElements(Array.from({ length: LIGHT_CAP + 2 }, (_, k) => candle(0.1 * k)));
    expect(readElements("sill", new URLSearchParams({ [ELEMENTS_KEY]: many }))).toHaveLength(
      LIGHT_CAP - 1,
    );
  });
});
