import { describe, expect, test } from "bun:test";
import { formatKeystroke, keystrokeLabel, keystrokeMatches, parseKeystroke } from "./bindings.ts";

/**
 * THE KEYSTROKE GRAMMAR, which is load-bearing in a way a bare key never was: the moment a row
 * can name `Mod+k`, "which event answers this row" stops being string equality and becomes a
 * decision — and that decision is what stands between a command surface opening on Ctrl-K and
 * a rename field losing its letters.
 */

const press = (
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {},
): { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean } => ({
  key,
  ctrlKey: modifiers.ctrl ?? false,
  metaKey: modifiers.meta ?? false,
  altKey: modifiers.alt ?? false,
});

describe("keystroke grammar", () => {
  test("a bare key round-trips and a chord round-trips", () => {
    expect(parseKeystroke("F8")).toEqual({ mod: false, key: "F8" });
    expect(parseKeystroke("Mod+k")).toEqual({ mod: true, key: "k" });
    expect(formatKeystroke({ mod: false, key: "F8" })).toBe("F8");
    expect(formatKeystroke({ mod: true, key: "k" })).toBe("Mod+k");
  });

  test("ONE token for the platform's primary modifier: Control and Command both answer", () => {
    expect(keystrokeMatches("Mod+k", press("k", { ctrl: true }))).toBe(true);
    expect(keystrokeMatches("Mod+k", press("k", { meta: true }))).toBe(true);
  });

  test("a chord row refuses the bare key, and a bare row refuses the chord", () => {
    // The precedence the old dispatcher enforced with a blanket modifier check, kept exactly:
    // a modifier makes a DIFFERENT keystroke, so neither row can answer for the other.
    expect(keystrokeMatches("Mod+k", press("k"))).toBe(false);
    expect(keystrokeMatches("F8", press("F8", { ctrl: true }))).toBe(false);
    expect(keystrokeMatches("F8", press("F8"))).toBe(true);
  });

  test("Alt never matches: it changes the character the layout produces", () => {
    expect(keystrokeMatches("Mod+k", press("k", { ctrl: true, alt: true }))).toBe(false);
    expect(keystrokeMatches("k", press("k", { alt: true }))).toBe(false);
  });

  test("a single character compares case-insensitively, a named key exactly", () => {
    // Shift already lives inside `event.key`, so a Mac reporting `K` and a PC reporting `k`
    // must both answer one row — while `ArrowUp` must never be answered by `arrowup`.
    expect(keystrokeMatches("Mod+k", press("K", { meta: true }))).toBe(true);
    expect(keystrokeMatches("ArrowUp", press("arrowup"))).toBe(false);
    expect(keystrokeMatches("ArrowUp", press("ArrowUp"))).toBe(true);
  });

  test("the label wears the mark of the keyboard in front of the reader", () => {
    expect(keystrokeLabel("Mod+k", true)).toBe("⌘ K");
    expect(keystrokeLabel("Mod+k", false)).toBe("Ctrl K");
    expect(keystrokeLabel("F8", false)).toBe("F8");
  });
});
