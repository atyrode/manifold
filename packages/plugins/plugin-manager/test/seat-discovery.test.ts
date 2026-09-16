import { describe, expect, test } from "bun:test";
import type { PluginRosterEntry, TileLayout } from "@manifold/protocol";
import {
  dismissSeatSuggestions,
  initialSeatSuggestions,
  missingWorkspacePanelSeats,
  reconcileSeatSuggestions,
  suggestedWorkspacePanelSeats,
  workspacePanelSeats,
} from "../src/seat-discovery.ts";

function row(
  id: string,
  enabled: boolean,
  panels: readonly { readonly id: string; readonly title: string }[] = [
    { id: "main", title: "Main" },
  ],
): PluginRosterEntry {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: "",
      capabilities: [],
      contributes: {
        panels: [...panels],
        seats: panels.map((panel, order) => ({ panel: panel.id, order })),
        sections: [],
        elements: [],
        tools: [],
        events: [],
      },
    },
    enabled,
    source: "plugin",
    actions: [],
  };
}

function layout(...panelIds: readonly string[]): TileLayout {
  if (panelIds.length === 1) {
    return {
      root: {
        id: "root",
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "panel", panelId: panelIds[0] ?? "" },
      },
    };
  }
  return {
    root: {
      id: "root",
      dir: "row",
      ratios: panelIds.map(() => 1),
      children: panelIds.map((_, index) => `seat-${String(index)}`),
      ref: null,
    },
    ...Object.fromEntries(
      panelIds.map((panelId, index) => [
        `seat-${String(index)}`,
        {
          id: `seat-${String(index)}`,
          dir: null,
          ratios: [],
          children: [],
          ref: { kind: "panel" as const, panelId },
        },
      ]),
    ),
  };
}

const shell = layout("core.shell.sidebar");

describe("workspace panel seats", () => {
  test("resolves only declared seats and filters panels already present", () => {
    const entry = row("example.notes", true, [
      { id: "notes", title: "Notes" },
      { id: "search", title: "Search" },
    ]);
    expect(workspacePanelSeats(entry)).toEqual([
      { pluginId: "example.notes", panelId: "example.notes.notes", title: "Notes" },
      { pluginId: "example.notes", panelId: "example.notes.search", title: "Search" },
    ]);
    expect(missingWorkspacePanelSeats(entry, layout("example.notes.notes"))).toEqual([
      { pluginId: "example.notes", panelId: "example.notes.search", title: "Search" },
    ]);
  });
});

describe("enable-time seat suggestions", () => {
  test("does not nudge for initially enabled plugins, while a later enable suggests every missing panel", () => {
    const enabled = row("example.notes", true, [
      { id: "notes", title: "Notes" },
      { id: "search", title: "Search" },
    ]);
    expect(
      suggestedWorkspacePanelSeats(initialSeatSuggestions([enabled]), [enabled], shell),
    ).toEqual([]);

    const disabled = { ...enabled, enabled: false };
    let state = initialSeatSuggestions([disabled]);
    state = reconcileSeatSuggestions(state, [enabled], shell);
    expect(
      suggestedWorkspacePanelSeats(state, [enabled], shell).map((seat) => seat.panelId),
    ).toEqual(["example.notes.notes", "example.notes.search"]);
  });

  test("dismissal survives roster rerenders, but disable and re-enable creates a fresh suggestion", () => {
    const disabled = row("example.notes", false);
    const enabled = { ...disabled, enabled: true };
    let state = reconcileSeatSuggestions(initialSeatSuggestions([disabled]), [enabled], shell);
    state = dismissSeatSuggestions(state);
    state = reconcileSeatSuggestions(state, [{ ...enabled }], shell);
    expect(suggestedWorkspacePanelSeats(state, [enabled], shell)).toEqual([]);

    state = reconcileSeatSuggestions(state, [disabled], shell);
    state = reconcileSeatSuggestions(state, [enabled], shell);
    expect(suggestedWorkspacePanelSeats(state, [enabled], shell)).toHaveLength(1);
  });

  test("live enabled arrivals join the queue, while already seated and fully added panels do not", () => {
    const first = row("example.first", true);
    const second = row("example.second", true);
    let state = initialSeatSuggestions([]);
    state = reconcileSeatSuggestions(state, [first], layout("example.first.main"));
    expect(suggestedWorkspacePanelSeats(state, [first], shell)).toEqual([]);

    state = reconcileSeatSuggestions(state, [first, second], shell);
    expect(
      suggestedWorkspacePanelSeats(state, [first, second], shell).map((seat) => seat.panelId),
    ).toEqual(["example.second.main"]);

    const completed = layout("core.shell.sidebar", "example.second.main");
    state = reconcileSeatSuggestions(state, [first, second], completed);
    expect(suggestedWorkspacePanelSeats(state, [first, second], completed)).toEqual([]);
  });

  test("an enable observed before layout load remains pending until the tree arrives", () => {
    const disabled = row("example.notes", false);
    const enabled = { ...disabled, enabled: true };
    const state = reconcileSeatSuggestions(initialSeatSuggestions([disabled]), [enabled], null);
    expect(state.pending).toEqual(["example.notes"]);
    expect(suggestedWorkspacePanelSeats(state, [enabled], null)).toEqual([]);
    expect(suggestedWorkspacePanelSeats(state, [enabled], shell)).toHaveLength(1);
  });
});
