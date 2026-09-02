import {
  DEFAULT_SEAT_RATIO,
  MAX_TILE_CHILDREN,
  ROOT_TILE_ID,
  type PluginRoster,
  type Tile,
  type TileLayout,
} from "@manifold/protocol";
import { panelRefId } from "./assemble.ts";

/**
 * ── THE DEFAULT WORKSPACE, COMPOSED ──────────────────────────────────────────────────
 *
 * What a principal who has never arranged a workspace is shown, derived from the ROSTER
 * instead of authored anywhere (ADR 0017 stage S17-B). Every enabled plugin's declared seats
 * (`contributes.seats`) are laid out in one row, in one total order, and the result is an
 * ordinary `TileLayout` — the same tree `core.space.setLayout` writes and the same tree the
 * tile renderer paints.
 *
 * WHY IT IS DERIVED. The engine used to hold the arrangement in a function and the two panel
 * NAMES in each `assembly.ts`, which made the shipped default a favourite pair of plugins
 * spelled in a registration file: enable a new panel plugin and it appeared nowhere until
 * somebody edited the floor. Composing from manifests makes "what does a fresh workspace look
 * like" a function of which plugins are on — the rule the sidebar already follows for its rows
 * — and deletes the constant that was the second answer to it.
 *
 * WHY IT TAKES THE ROSTER. Same reason `rosterElementTraits` does: the roster is what BOTH
 * halves hold. The server has an `Assembly`, the browser has its own join of the published
 * roster with its components, and a composer typed to either one would need a second
 * implementation for the other — two answers to "where does a fresh workspace put things".
 * Reading the published document means both halves compose from the declaration a stranger's
 * agent also reads at `GET /api/plugins`.
 *
 * WHAT IT IS NOT. This is the DEFAULT and nothing else. A principal's stored tree is theirs;
 * it is read straight out of the store and never recomposed, because a workspace somebody
 * arranged is a document, not a preference the roster gets to re-derive. Toggling a plugin
 * therefore changes what the next unarranged principal sees and touches nobody's arrangement.
 */

/**
 * What the composition found, named so a shell can say it rather than show a blank tree:
 *
 * - `seated` — at least one enabled plugin asked for a seat, and the tree holds them all.
 * - `unseated` — the roster asked for nothing. The tree is an empty-but-valid root leaf (a
 *   vacant drop target, which every renderer already names), never a missing tree.
 * - `crowded` — more seats were asked for than a split may hold ({@link MAX_TILE_CHILDREN},
 *   the wire's own fan-out bound). The first ones in seat order are seated and the condition
 *   names the overflow, because dropping seats silently and answering a 500 are both worse.
 */
export const DEFAULT_LAYOUT_CONDITIONS = ["seated", "unseated", "crowded"] as const;
export type DefaultLayoutCondition = (typeof DEFAULT_LAYOUT_CONDITIONS)[number];

export interface DefaultLayout {
  readonly layout: TileLayout;
  readonly condition: DefaultLayoutCondition;
}

/**
 * WHAT TO TELL A READER whose default workspace is not the ordinary one — one sentence per
 * condition, so the unusual cases are SAID rather than left to be inferred from an empty pane.
 *
 * It lives beside the vocabulary it names for the same reason `panelArrangeMessage` lives
 * beside the arrange rules: a named condition with no sentence anywhere is a condition a UI
 * ends up paraphrasing differently in each place it can occur. `seated` has no notice because
 * there is nothing unusual to report.
 */
export const DEFAULT_LAYOUT_NOTICES: Record<DefaultLayoutCondition, string | null> = {
  seated: null,
  unseated: "No enabled plugin asks for a place in the workspace, so it opens empty.",
  crowded: `More plugins ask for a place than one row holds (${String(MAX_TILE_CHILDREN)}), so the last of them are not seated.`,
};

/** One resolved ask: the full panel id, a ratio rather than an absence, and its place. */
interface Seat {
  readonly panel: string;
  readonly order: number;
  readonly ratio: number;
}

/**
 * Every seat the ENABLED half of the roster asked for, in the order they are laid out.
 *
 * TOTAL, not merely sorted: a tie on `order` falls through to the full panel id, which begins
 * with the owning plugin's id. Two instances holding one roster therefore compose the same
 * tree, whatever order their registration files happen to list plugins in.
 *
 * A DISABLED plugin seats nothing. Its declaration is still in the roster — a row is published
 * whether it is on or off, so a client can name what it is missing (D4′) — and this is where
 * the distinction is applied, because a placeholder in a fresh principal's workspace would be
 * a promise about a plugin nobody turned on.
 */
function askedSeats(roster: PluginRoster): readonly Seat[] {
  const seats: Seat[] = [];
  for (const entry of roster) {
    if (!entry.enabled) continue;
    for (const seat of entry.manifest.contributes.seats ?? []) {
      seats.push({
        // The one implementation of the panel naming rule, so a seat's leaf ref spells a panel
        // exactly as the panel registry claims it.
        panel: panelRefId(entry.manifest.id, seat.panel),
        order: seat.order,
        // Resolved here, so nothing downstream has to know the rule for a manifest that
        // declared no weight — the same discipline `presentation` and `placement` follow.
        ratio: seat.ratio ?? DEFAULT_SEAT_RATIO,
      });
    }
  }
  seats.sort(
    (left, right) =>
      left.order - right.order ||
      (left.panel < right.panel ? -1 : left.panel > right.panel ? 1 : 0),
  );
  return seats;
}

/**
 * The tile id of the nth composed seat, counting from one. ENGINE GRAMMAR, exactly like
 * `root`: it names a place in the tree and never its occupant, so the ids are unchanged if
 * every plugin in the roster is replaced by different plugins (AXIOMS.md §Foundation law).
 */
function seatTileId(index: number): string {
  return `ws-seat-${String(index + 1)}`;
}

function leaf(id: string, panelId: string | null): Tile {
  return {
    id,
    dir: null,
    ratios: [],
    children: [],
    ref: panelId === null ? null : { kind: "panel", panelId },
  };
}

/**
 * Compose the default workspace tree from the roster's seat intents.
 *
 * Pure and TOTAL: every roster composes a tree `validateTileLayout` accepts, including the
 * roster that asks for nothing, because the alternative to a valid empty tree is a door that
 * throws on `GET /api/layout` for a workspace whose plugins merely happen to be all off.
 *
 * Two shapes, and the boundary is the tile grammar's rather than a preference: a split must
 * hold two or more children, so a lone seat IS the root leaf instead of a one-child split the
 * next structural write would collapse anyway.
 */
export function composeDefaultLayout(roster: PluginRoster): DefaultLayout {
  const asked = askedSeats(roster);
  const seated = asked.slice(0, MAX_TILE_CHILDREN);
  const condition: DefaultLayoutCondition =
    seated.length === 0 ? "unseated" : asked.length > seated.length ? "crowded" : "seated";

  const first = seated[0];
  if (first === undefined) {
    return { layout: { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, null) }, condition };
  }
  if (seated.length === 1) {
    return { layout: { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, first.panel) }, condition };
  }

  const layout: Record<string, Tile> = {
    // Root first, so a serialized tree reads from its entry point down.
    [ROOT_TILE_ID]: {
      id: ROOT_TILE_ID,
      dir: "row",
      // The declared weights, passed through rather than normalized: a split's ratios ARE
      // relative, the renderer divides by their sum, and dividing here would turn the
      // manifest's exact 0.22 into a float nobody wrote.
      ratios: seated.map((seat) => seat.ratio),
      children: seated.map((_, index) => seatTileId(index)),
      ref: null,
    },
  };
  for (const [index, seat] of seated.entries()) {
    const id = seatTileId(index);
    layout[id] = leaf(id, seat.panel);
  }
  return { layout, condition };
}
