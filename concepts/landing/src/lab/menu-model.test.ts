import { describe, expect, test } from "bun:test";
import { chipState, chipStep, fitChips, stripRoom } from "./menu-model.ts";

describe("chipState", () => {
  test("a section at its defaults is dark, named by its title alone", () => {
    expect(chipState("Sky", 0, undefined)).toEqual({
      lit: false,
      switched: undefined,
      label: "Sky",
    });
  });

  test("changes light it and are counted in its name", () => {
    expect(chipState("Weather", 2, undefined)).toEqual({
      lit: true,
      switched: undefined,
      label: "Weather (2 changed)",
    });
  });

  test("a master switch shows on or off, ahead of the changes", () => {
    expect(chipState("Birds", 0, false)).toEqual({
      lit: false,
      switched: "off",
      label: "Birds (off)",
    });
    expect(chipState("Birds", 1, true)).toEqual({
      lit: true,
      switched: "on",
      label: "Birds (on, 1 changed)",
    });
  });

  test("a change behind a switch that is off still lights it, as the lens counts it", () => {
    expect(chipState("Koi", 1, false).lit).toBe(true);
  });
});

describe("fitChips", () => {
  test("titles while every chip fits with its title", () => {
    expect(fitChips(600, 300, 600)).toBe("titled");
    expect(fitChips(600, 300, 900)).toBe("titled");
  });

  test("icons alone once the titles do not fit, all of them together", () => {
    expect(fitChips(601, 300, 600)).toBe("icons");
    expect(fitChips(1100, 360, 360)).toBe("icons");
  });

  test("icons that scroll once even those do not fit", () => {
    expect(fitChips(1100, 361, 360)).toBe("scroll");
    expect(fitChips(1100, 360, 0)).toBe("scroll");
  });
});

describe("stripRoom", () => {
  test("a floating bar short of its limit gives the strip what it may still grow by", () => {
    expect(stripRoom(300, 700, 1424)).toBe(1024);
  });

  test("a bar at its limit, or docked across its edge, leaves the strip its own width", () => {
    expect(stripRoom(420, 1424, 1424)).toBe(420);
    expect(stripRoom(380, 390, 390)).toBe(380);
  });

  test("the room is the same whichever way the chips stand", () => {
    // Titled, the strip is 600 wide in a 900 bar; as icons, 300 wide in a 600 bar.
    expect(stripRoom(600, 900, 1424)).toBe(stripRoom(300, 600, 1424));
  });
});

describe("chipStep", () => {
  test("the arrows step along and round the ends", () => {
    expect(chipStep("ArrowRight", 0, 4)).toBe(1);
    expect(chipStep("ArrowRight", 3, 4)).toBe(0);
    expect(chipStep("ArrowLeft", 0, 4)).toBe(3);
    expect(chipStep("ArrowLeft", 2, 4)).toBe(1);
  });

  test("Home and End go to the ends", () => {
    expect(chipStep("Home", 2, 4)).toBe(0);
    expect(chipStep("End", 1, 4)).toBe(3);
  });

  test("other keys, or no chip in hand, go nowhere", () => {
    expect(chipStep("ArrowDown", 1, 4)).toBeUndefined();
    expect(chipStep("Enter", 1, 4)).toBeUndefined();
    expect(chipStep("ArrowRight", -1, 4)).toBeUndefined();
    expect(chipStep("ArrowRight", 0, 0)).toBeUndefined();
  });
});
