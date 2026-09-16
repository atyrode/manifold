import { panelRefId } from "@manifold/plugin";
import type { PluginRosterEntry, TileLayout } from "@manifold/protocol";

/** One manifest-declared workspace seat, resolved to its canonical full panel id. */
export interface WorkspacePanelSeat {
  readonly pluginId: string;
  readonly panelId: string;
  readonly title: string;
}

/**
 * Session-local enable suggestions. `enabled` is the previous live roster observation;
 * `pending` contains only plugins whose absent→enabled transition has not been dismissed or
 * completely seated. Keeping this state out of storage makes dismissal last until the next
 * disable/re-enable transition and no longer.
 */
export interface SeatSuggestionState {
  readonly enabled: ReadonlyMap<string, boolean>;
  readonly pending: readonly string[];
}

/** Every panel this plugin explicitly asks to seat, in its declared workspace order. */
export function workspacePanelSeats(entry: PluginRosterEntry): readonly WorkspacePanelSeat[] {
  const panels = new Map(entry.manifest.contributes.panels.map((panel) => [panel.id, panel.title]));
  return [...(entry.manifest.contributes.seats ?? [])]
    .sort(
      (left, right) =>
        left.order - right.order ||
        (panelRefId(entry.manifest.id, left.panel) < panelRefId(entry.manifest.id, right.panel)
          ? -1
          : panelRefId(entry.manifest.id, left.panel) > panelRefId(entry.manifest.id, right.panel)
            ? 1
            : 0),
    )
    .flatMap((seat) => {
      const title = panels.get(seat.panel);
      return title === undefined
        ? []
        : [
            {
              pluginId: entry.manifest.id,
              panelId: panelRefId(entry.manifest.id, seat.panel),
              title,
            },
          ];
    });
}

/** Which of this plugin's declared seats are absent from the principal's current tree. */
export function missingWorkspacePanelSeats(
  entry: PluginRosterEntry,
  layout: TileLayout | null,
): readonly WorkspacePanelSeat[] {
  if (layout === null) return [];
  const seated = new Set(
    Object.values(layout)
      .map((tile) => tile.ref)
      .filter((ref) => ref?.kind === "panel")
      .map((ref) => ref.panelId),
  );
  return workspacePanelSeats(entry).filter((seat) => !seated.has(seat.panelId));
}

/** Existing enabled plugins are discoverable in their detail sheets, but do not raise a nudge. */
export function initialSeatSuggestions(roster: readonly PluginRosterEntry[]): SeatSuggestionState {
  return {
    enabled: new Map(roster.map((entry) => [entry.manifest.id, entry.enabled])),
    pending: [],
  };
}

/**
 * Advances suggestions from the live roster. A newly present or newly enabled plugin enters
 * the queue only when it has an absent declared seat. Dismissal is represented by removing it
 * from `pending`: it cannot return while the previous observation remains enabled, but a later
 * disable/re-enable transition adds it again. Panels seated elsewhere retire the nudge without
 * mutating the layout.
 */
export function reconcileSeatSuggestions(
  state: SeatSuggestionState,
  roster: readonly PluginRosterEntry[],
  layout: TileLayout | null,
): SeatSuggestionState {
  const enabled = new Map(roster.map((entry) => [entry.manifest.id, entry.enabled]));
  const rows = new Map(roster.map((entry) => [entry.manifest.id, entry]));
  const hasMissingSeat = (entry: PluginRosterEntry): boolean =>
    layout === null
      ? workspacePanelSeats(entry).length > 0
      : missingWorkspacePanelSeats(entry, layout).length > 0;
  const pending = state.pending.filter((id) => {
    const entry = rows.get(id);
    return entry !== undefined && entry.enabled && hasMissingSeat(entry);
  });
  const pendingIds = new Set(pending);

  for (const entry of roster) {
    if (
      entry.enabled &&
      state.enabled.get(entry.manifest.id) !== true &&
      hasMissingSeat(entry) &&
      !pendingIds.has(entry.manifest.id)
    ) {
      pending.push(entry.manifest.id);
      pendingIds.add(entry.manifest.id);
    }
  }

  const enabledUnchanged =
    enabled.size === state.enabled.size &&
    [...enabled].every(([id, value]) => state.enabled.get(id) === value);
  const pendingUnchanged =
    pending.length === state.pending.length &&
    pending.every((id, index) => state.pending[index] === id);
  return enabledUnchanged && pendingUnchanged ? state : { enabled, pending };
}

/** Dismiss every currently visible enable-time nudge without hiding detail-sheet controls. */
export function dismissSeatSuggestions(state: SeatSuggestionState): SeatSuggestionState {
  return state.pending.length === 0 ? state : { ...state, pending: [] };
}

/** Missing seats represented by the current suggestion queue, in transition order. */
export function suggestedWorkspacePanelSeats(
  state: SeatSuggestionState,
  roster: readonly PluginRosterEntry[],
  layout: TileLayout | null,
): readonly WorkspacePanelSeat[] {
  if (layout === null) return [];
  const rows = new Map(roster.map((entry) => [entry.manifest.id, entry]));
  return state.pending.flatMap((id) => {
    const entry = rows.get(id);
    return entry === undefined ? [] : missingWorkspacePanelSeats(entry, layout);
  });
}
