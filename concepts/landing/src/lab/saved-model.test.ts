import { describe, expect, test } from "bun:test";
import { kinds } from "../engine/kinds/index.ts";
import type { EngineDoc } from "../engine/types.ts";
import type { Preset } from "../presets.ts";
import type { SavedDoc } from "./canvas-docs.ts";
import {
  exportSaved,
  freeName,
  mergeSaved,
  readSaved,
  savedItems,
  savedMatches,
  savedName,
} from "./saved-model.ts";

const setup = (name: string, savedAt: string, query = "scene=sill&rain=1"): Preset => ({
  name,
  commit: "abc12345",
  query,
  savedAt,
});

const doc = (title: string, kind = "lamp"): EngineDoc => ({
  v: 1,
  title,
  camera: { at: [0, 1.6, -4], yaw: 0, pitch: 0, fov: 1 },
  world: {},
  objects: [{ id: `${kind}-1`, kind, at: [0, 0, 0], yaw: 0, scale: 1, options: {} }],
});

const saved = (name: string, savedAt: number, title = name): SavedDoc => ({
  name,
  savedAt,
  doc: doc(title),
});

describe("the Saved list", () => {
  test("holds setups and documents together, the last saved first", () => {
    const items = savedItems(
      [setup("Old rain", "2026-10-01"), setup("Dusk", "2026-10-19T09:00:00.000Z")],
      [
        saved("Lamp room", Date.parse("2026-10-19T08:00:00.000Z")),
        saved("Grove", Date.parse("2026-10-20T00:00:00.000Z")),
      ],
    );
    expect(items.map(savedName)).toEqual(["Grove", "Dusk", "Lamp room", "Old rain"]);
  });

  test("puts the one stored later first of two saved the same day", () => {
    const items = savedItems([setup("First", "2026-10-19"), setup("Second", "2026-10-19")], []);
    expect(items.map(savedName)).toEqual(["Second", "First"]);
  });

  test("matches a setup by its scene and a document by the kinds it holds", () => {
    const [rain, lamp] = savedItems([setup("Mine", "2026-10-19")], [saved("Evening", 0)]);
    if (rain === undefined || lamp === undefined) throw new Error("two entries");
    expect(savedMatches(rain, "sill")).toBe(true);
    expect(savedMatches(rain, "lamp")).toBe(false);
    expect(savedMatches(lamp, "LAMP")).toBe(true);
    expect(savedMatches(lamp, "sill")).toBe(false);
    expect(savedMatches(lamp, "")).toBe(true);
  });
});

describe("a file of saved entries", () => {
  test("reads back what was exported", () => {
    const setups = [setup("Dusk", "2026-10-19")];
    const docs = [saved("Grove", 5, "A grove")];
    const read = readSaved(exportSaved(setups, docs).text, kinds);
    expect(read).toEqual({ setups, docs: [{ name: "Grove", doc: doc("A grove") }] });
  });

  test("reads a document's own file under its title, and setups as the lab once exported them", () => {
    expect(readSaved(JSON.stringify(doc("Lamp room")), kinds)).toEqual({
      setups: [],
      docs: [{ name: "Lamp room", doc: doc("Lamp room") }],
    });
    const [a, b] = [setup("A", "2026-10-10"), setup("B", "2026-10-11")];
    const old = [a, b];
    expect(readSaved(JSON.stringify(old), kinds)).toEqual({ setups: old, docs: [] });
    expect(readSaved(JSON.stringify(a), kinds)).toEqual({ setups: [a], docs: [] });
  });

  test("refuses a whole file for one document it cannot read, saying which", () => {
    const text = JSON.stringify({
      v: 1,
      setups: [setup("Dusk", "2026-10-19")],
      docs: [saved("Fine", 1), { name: "Odd", doc: doc("Odd", "dragon") }],
    });
    const read = readSaved(text, kinds);
    expect("why" in read && read.why).toStartWith("Document 2: ");
    expect("why" in read && read.why).toContain("dragon");
  });

  test("refuses what is not one, an unknown version and an empty file", () => {
    for (const text of [
      "not json",
      "[]",
      "42",
      JSON.stringify({ v: 2, docs: [] }),
      JSON.stringify({ v: 1 }),
    ])
      expect("why" in readSaved(text, kinds)).toBe(true);
  });

  test("adds its documents under names free here, never over what is saved", () => {
    const here = [saved("Grove", 1), saved("Grove 2", 2)];
    const merged = mergeSaved(
      [setup("Mine", "2026-10-01")],
      here,
      {
        setups: [setup("Theirs", "2026-10-02")],
        docs: [{ name: "Grove", doc: doc("Their grove") }],
      },
      99,
    );
    expect(merged.setups.map((entry) => entry.name)).toEqual(["Mine", "Theirs"]);
    expect(merged.docs.map((entry) => [entry.name, entry.doc.title, entry.savedAt])).toEqual([
      ["Grove", "Grove", 1],
      ["Grove 2", "Grove 2", 2],
      ["Grove 3", "Their grove", 99],
    ]);
  });
});

test("a free name is the name itself, or the first number after it not taken", () => {
  expect(freeName("Grove", [])).toBe("Grove");
  expect(freeName("Grove", ["Grove", "Grove 3"])).toBe("Grove 2");
});
