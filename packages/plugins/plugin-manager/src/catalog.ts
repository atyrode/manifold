import type { PluginRosterEntry } from "@manifold/protocol";
import { needsAttention, permissionCount, pluginStatus } from "./status.ts";

/**
 * THE CATALOG: the roster as a READER navigates it, and nothing more.
 *
 * The roster is the one published plugin list (`GET /api/plugins`, pushed on the connection
 * frame) and this module never becomes a second one — it derives a VIEW of it: grouped by
 * where a row came from, nested by family, narrowed by a search word and a set of filter
 * chips, ordered by whichever axis the reader chose. Every function here takes the roster it
 * is asked about and returns fresh arrays, so there is no cached copy of the list to disagree
 * with the server's (invariant 14: one list, one door).
 *
 * It lives beside the component instead of inside it because grouping, nesting, matching and
 * ordering are POLICY, and policy that can only be exercised by mounting React is policy
 * nobody tests (AGENTS.md §Conventions). Everything below is pure and total: no `undefined`
 * returns, no throwing on an id the roster has never heard of, and an empty roster answers
 * with empty structure rather than a special case the caller must remember.
 */

/**
 * A SECTION is the answer to "where did this row come from" (#239), and the sections are ONE
 * ARRAY: each entry carries its words, its behaviour flags and the PREDICATE that claims a
 * row. The first entry whose predicate holds wins, and the array's order is the display
 * order — so a new section (ADR 0024's "Mine", the plugins authored on this instance, once
 * the roster's `install.mode` can say `"unpacked"`) is one entry placed before the band it
 * would otherwise fall into, and nothing else in this file or the component changes.
 *
 * `source` alone cannot draw the bands: the protocol's closed set separates the ENGINE's
 * builtin rows from everything the composition assembled, so every shipped seat and a
 * stranger's plugin would share one heading. The axis is the row's own NAMESPACE, which is
 * where "shipped with manifold" is actually written: `engine.` is reserved for the engine's
 * doors and `core.` for the seats in the box, both refused to anybody else by assembly — so
 * anything else is a plugin somebody put here, which is the only remaining thing it can be.
 *
 * Obsidian's rule: core and community are different worlds, each with its own copy. The
 * `note` is the one sentence under the heading that says what the band IS, and the `empty`
 * is what it says with nothing in it — a claim about the WORKSPACE ("no installed plugins"),
 * which the component keeps distinct from "nothing matches", a claim about what the reader
 * just typed.
 */
interface SectionShape {
  readonly kind: string;
  readonly title: string;
  readonly note: string;
  readonly empty: string;
  /** Whether a row belongs here. The first section in the array whose predicate holds wins. */
  readonly holds: (entry: PluginRosterEntry) => boolean;
  /** The rows carry a switch; false for the engine, whose doors nobody can turn off. */
  readonly toggleable: boolean;
  /** Folded on a device that has never unfolded it. */
  readonly collapsedByDefault: boolean;
  /** Rows group by the first id segment before the chosen sort applies. */
  readonly byPublisher: boolean;
  /** The install form lives under this band's heading. */
  readonly installs: boolean;
}

const CORE_NAMESPACE_PREFIX = "core.";

export const PLUGIN_SECTIONS = [
  {
    kind: "installed",
    title: "Installed",
    note: "Bundles somebody consented to: a stranger's code, isolated, holding only the capabilities its installer granted.",
    empty: "No installed plugins. Install one from a bundle.",
    holds: (entry: PluginRosterEntry) =>
      entry.source !== "builtin" && !entry.manifest.id.startsWith(CORE_NAMESPACE_PREFIX),
    toggleable: true,
    collapsedByDefault: false,
    byPublisher: true,
    installs: true,
  },
  {
    kind: "core",
    title: "Built-in",
    note: "The seats that ship in the box. Turning one off keeps its data; purge is the verb that destroys it.",
    empty: "No built-in plugins composed.",
    holds: (entry: PluginRosterEntry) =>
      entry.source !== "builtin" && entry.manifest.id.startsWith(CORE_NAMESPACE_PREFIX),
    toggleable: true,
    collapsedByDefault: false,
    byPublisher: false,
    installs: false,
  },
  {
    kind: "engine",
    title: "Engine",
    note: "The engine's own doors: always on, because the thing that would switch one off is itself.",
    empty: "No engine doors published.",
    holds: (entry: PluginRosterEntry) => entry.source === "builtin",
    toggleable: false,
    collapsedByDefault: true,
    byPublisher: false,
    installs: false,
  },
] as const satisfies readonly SectionShape[];

export type PluginSectionDef = (typeof PLUGIN_SECTIONS)[number];
export type PluginCategoryKind = PluginSectionDef["kind"];

/**
 * WHICH SECTION a row belongs to: the first whose predicate holds. The three predicates above
 * partition every roster row (builtin / `core.` / the rest), so the fallback never fires; it
 * names the first band rather than throwing because a row the bands forgot is better SEEN
 * where an operator looks first than dropped from the ledger.
 */
export function pluginSection(entry: PluginRosterEntry): PluginSectionDef {
  return PLUGIN_SECTIONS.find((section) => section.holds(entry)) ?? PLUGIN_SECTIONS[0];
}

export function pluginCategoryKind(entry: PluginRosterEntry): PluginCategoryKind {
  return pluginSection(entry).kind;
}

/** The id's first segment: the authority that published it (`packages/protocol/src/plugin.ts`). */
export function publisherOf(id: string): string {
  return id.slice(0, id.indexOf("."));
}

/**
 * WHO A PLUGIN'S PARENT IS, or null when it has none (ADR 0023 §2, issue #239).
 *
 * Three things must all hold, and each one alone is a peer:
 *
 *   1. the id has exactly THREE segments — `publisher.product.part`. Two segments claim
 *      nothing (the first is an authority, not a plugin), and depth is capped at three;
 *   2. the PARENT — the id minus its last segment — is a row on this roster. A three-segment
 *      id whose home was never composed is not a child of anything a reader can see;
 *   3. the child DECLARES the parent as a `required` dependency. The id is the claim and the
 *      edge is the proof: without it the engine has no idea the two are related, and the
 *      manager would be drawing a hierarchy the door does not enforce.
 *
 * A peer with an ordinary `required` edge (`core.draw` → `core.canvas`) fails (1) and stays a
 * peer; that relationship is the Relations card's, never a nesting.
 */
export function parentOf(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): string | null {
  const id = entry.manifest.id;
  const segments = id.split(".");
  if (segments.length !== 3) return null;
  const parentId = `${segments[0] ?? ""}.${segments[1] ?? ""}`;
  if (!roster.some((candidate) => candidate.manifest.id === parentId)) return null;
  return entry.manifest.dependencies?.[parentId]?.type === "required" ? parentId : null;
}

/** The children of `id` on this roster, by the rule above; empty for a peer. */
export function childrenOf(
  roster: readonly PluginRosterEntry[],
  id: string,
): readonly PluginRosterEntry[] {
  return roster.filter((entry) => parentOf(roster, entry) === id);
}

/**
 * The family's one-line summary on the parent row: which parts are on. A single child is
 * named ("generator on", "generator off"); several are counted ("1 of 2 parts on").
 */
export function familySummary(children: readonly PluginRosterEntry[]): string {
  if (children.length === 0) return "";
  const on = children.filter((child) => child.enabled).length;
  if (children.length === 1) {
    const only = children[0];
    const part =
      only === undefined ? "" : only.manifest.id.slice(only.manifest.id.lastIndexOf(".") + 1);
    return `${part} ${on === 1 ? "on" : "off"}`;
  }
  return `${String(on)} of ${String(children.length)} parts on`;
}

/**
 * The axes a reader may order the list by. `name` is the resting default; the others answer a
 * question — "what is broken", "what moved lately", "what holds the most authority" — and
 * each is a total comparator below, so adding a fifth is a compile error here.
 */
export const PLUGIN_SORTS = ["name", "status", "changed", "permissions"] as const;
export type PluginSort = (typeof PLUGIN_SORTS)[number];

export const PLUGIN_SORT_LABELS: Readonly<Record<PluginSort, string>> = {
  name: "Name",
  status: "Status",
  changed: "Recently changed",
  permissions: "Permissions",
};

/**
 * The filter CHIPS, each a toggle. Every active chip must hold for a row to survive (AND):
 * "Installed" and "Off" together are the installed plugins that are off, which is the question
 * the pair asks. Two chips on one axis ("On" and "Off") legitimately match nothing, and the
 * list says so rather than guessing which one the reader meant.
 */
export const PLUGIN_FILTERS = ["enabled", "disabled", "attention", "installed", "builtin"] as const;
export type PluginFilter = (typeof PLUGIN_FILTERS)[number];

export const PLUGIN_FILTER_LABELS: Readonly<Record<PluginFilter, string>> = {
  enabled: "On",
  disabled: "Off",
  attention: "Needs attention",
  installed: "Installed",
  builtin: "Built-in",
};

function matchesFilter(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
  filter: PluginFilter,
): boolean {
  switch (filter) {
    case "enabled":
      return entry.enabled;
    case "disabled":
      return !entry.enabled;
    case "attention":
      return needsAttention(roster, entry);
    case "installed":
      return entry.install !== undefined;
    case "builtin":
      return pluginCategoryKind(entry) === "core";
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

/**
 * The search, over the fields a reader could plausibly be typing from: the id they saw in a
 * refusal message, the title they saw in the rail, the description that is the only text
 * saying what an unfamiliar plugin is for, and the names of the DOORS it publishes — a reader
 * who saw `core.index.createFolder` in a trace and wants to know which plugin owns it types
 * the door. Substring rather than prefix, and case-insensitive because an id is lowercase
 * while a title is not.
 *
 * An empty needle matches EVERYTHING — the identity of the search, which is what lets the
 * component hold one code path for "searching" and "not searching".
 */
function matchesQuery(entry: PluginRosterEntry, needle: string): boolean {
  if (needle === "") return true;
  const { manifest } = entry;
  return (
    manifest.id.toLowerCase().includes(needle) ||
    manifest.title.toLowerCase().includes(needle) ||
    manifest.description.toLowerCase().includes(needle) ||
    entry.actions.some((action) => action.name.toLowerCase().includes(needle))
  );
}

/**
 * Rows read alphabetically BY TITLE under the default sort, because the title is what the
 * reader is scanning; the id breaks ties. Two plugins may legitimately share a title — ids
 * are namespaced by authority precisely so two authors can both ship "Terminals" (D5) — and a
 * comparison that answered "equal" there would let the list reorder itself between renders
 * over nothing. Every other sort falls back to this one, for the same reason.
 */
function compareByName(left: PluginRosterEntry, right: PluginRosterEntry): number {
  const byTitle = left.manifest.title.localeCompare(right.manifest.title);
  return byTitle !== 0 ? byTitle : left.manifest.id.localeCompare(right.manifest.id);
}

/** Status order: what needs attention first, then what is starting, then on, then off. */
function statusRank(roster: readonly PluginRosterEntry[], entry: PluginRosterEntry): number {
  const { tone } = pluginStatus(roster, entry);
  switch (tone) {
    case "attention":
      return 0;
    case "busy":
      return 1;
    case "on":
      return 2;
    case "off":
      return 3;
    default: {
      const exhaustive: never = tone;
      return exhaustive;
    }
  }
}

function comparator(
  roster: readonly PluginRosterEntry[],
  sort: PluginSort,
): (left: PluginRosterEntry, right: PluginRosterEntry) => number {
  switch (sort) {
    case "name":
      return compareByName;
    case "status":
      return (left, right) =>
        statusRank(roster, left) - statusRank(roster, right) || compareByName(left, right);
    case "changed":
      // Most recent first; a row nobody ever toggled sorts last, after everything with a time.
      return (left, right) =>
        (right.changedAt ?? -1) - (left.changedAt ?? -1) || compareByName(left, right);
    case "permissions":
      return (left, right) =>
        permissionCount(right) - permissionCount(left) || compareByName(left, right);
    default: {
      const exhaustive: never = sort;
      return exhaustive;
    }
  }
}

/** One family in the list: the row a reader sees, and the children under its chevron. */
export interface PluginFamilyRow {
  readonly entry: PluginRosterEntry;
  /** The row's children that survived the narrowing (every child, when the parent matched). */
  readonly children: readonly PluginRosterEntry[];
  /** Every child on the roster, narrowing aside: what the family summary counts. */
  readonly family: readonly PluginRosterEntry[];
  /**
   * The parent itself did not match; it is here only because a child did. The component
   * shows such a family OPEN, because the row a reader was looking for is the child.
   */
  readonly viaChild: boolean;
}

export interface PluginSection {
  readonly def: PluginSectionDef;
  readonly rows: readonly PluginFamilyRow[];
  /** Every row that belongs here before narrowing, children included: the heading's count. */
  readonly size: number;
  /** How many of those are on: the heading's "3 of 4 on". */
  readonly on: number;
}

/** What the reader asked the list for, in one value the component can hold in state. */
export interface CatalogQuery {
  readonly query: string;
  readonly sort: PluginSort;
  readonly filters: ReadonlySet<PluginFilter>;
}

/**
 * THE derivation: roster in, the sections of families out, in `PLUGIN_SECTIONS` order.
 *
 * Every section is ALWAYS present, empty or not — a heading is a collapsible band with its
 * own count and its own empty sentence, so "no installed plugins" is said where it is true
 * rather than inferred from a missing heading. Children are lifted out of the top level and
 * nested under their parent's row; the family survives the narrowing if the parent OR any
 * child does, and shows the matching children only unless the parent matched itself, in which
 * case the whole family is there to be expanded.
 *
 * A `byPublisher` section's rows are grouped by PUBLISHER before the chosen sort applies, so
 * a vendor's plugins read together whatever the sort — the publisher chip on each row is the
 * group's label, and the component draws the boundary where the publisher changes.
 */
export function pluginCatalog(
  roster: readonly PluginRosterEntry[],
  asked: CatalogQuery,
): readonly PluginSection[] {
  const needle = asked.query.trim().toLowerCase();
  const compare = comparator(roster, asked.sort);
  const matches = (entry: PluginRosterEntry): boolean =>
    matchesQuery(entry, needle) &&
    [...asked.filters].every((filter) => matchesFilter(roster, entry, filter));

  const drafts = PLUGIN_SECTIONS.map((def) => ({
    def,
    rows: [] as PluginFamilyRow[],
    size: 0,
    on: 0,
  }));
  for (const entry of roster) {
    const kind = pluginCategoryKind(entry);
    const draft = drafts.find((candidate) => candidate.def.kind === kind);
    if (draft === undefined) continue;
    draft.size += 1;
    if (entry.enabled) draft.on += 1;
    if (parentOf(roster, entry) !== null) continue;
    const family = childrenOf(roster, entry.manifest.id);
    const parentMatched = matches(entry);
    const matchingChildren = parentMatched ? family : family.filter(matches);
    if (!parentMatched && matchingChildren.length === 0) continue;
    draft.rows.push({
      entry,
      children: [...matchingChildren].sort(compare),
      family,
      viaChild: !parentMatched,
    });
  }
  return drafts.map(({ def, rows, size, on }) => ({
    def,
    rows: rows.sort((left, right) =>
      def.byPublisher
        ? publisherOf(left.entry.manifest.id).localeCompare(publisherOf(right.entry.manifest.id)) ||
          compare(left.entry, right.entry)
        : compare(left.entry, right.entry),
    ),
    size,
    on,
  }));
}

/**
 * What a plugin requires, what requires it, and what it cannot share a workspace with. Ids
 * only: a title is the assembly's answer (`host.assembly.pluginTitle`), and a policy module
 * that resolved them would be a second name table for plugins.
 */
export interface PluginRelations {
  readonly requires: readonly string[];
  readonly requiredBy: readonly string[];
  readonly incompatible: readonly string[];
}

/**
 * THE RELATIONS, derived from the roster's own manifests.
 *
 * The forward direction is a manifest read; the reverse direction exists nowhere in the
 * protocol and can only be computed by asking every other row what it declares — which is
 * exactly why it belongs here and not in a component. It is also the direction a reader
 * needs before pressing a toggle: "what does this require" explains a refusal that already
 * happened, while "what requires this" is the blast radius of a disable that has not happened
 * yet, and a card that only showed the first one would let someone turn off a plugin three
 * others were standing on.
 *
 * Only `required` counts as a requirement. `optional` refuses nothing by protocol definition —
 * it exists so a client can explain a DEGRADED experience — so listing it would tell a reader
 * something breaks when nothing does. `incompatible` is not a need but its opposite, read in
 * both directions because either side may have declared it. `after` is deliberately NOT read:
 * the protocol keeps requirement and ORDER on separate axes, and folding sequence into this
 * list would re-conflate the two things that split was made to keep apart.
 *
 * Ids are returned verbatim, including ones no roster row carries: a `required` dependency
 * that was never composed is the whole content of a `missing_dependency` refusal, so dropping
 * unresolvable ids would hide the one case a reader most needs to see. Sorted, so the card is
 * stable across renders and across servers.
 */
export function pluginRelations(roster: readonly PluginRosterEntry[], id: string): PluginRelations {
  const requires: string[] = [];
  const requiredBy: string[] = [];
  const incompatible = new Set<string>();
  for (const entry of roster) {
    const declared = entry.manifest.dependencies;
    if (declared === undefined) continue;
    if (entry.manifest.id === id) {
      for (const [target, dependency] of Object.entries(declared)) {
        if (dependency?.type === "required") requires.push(target);
        else if (dependency?.type === "incompatible") incompatible.add(target);
      }
      // A row is never its own dependent, so the self row is done here: reading it for the
      // reverse direction could only ever produce "requires itself", which is not a sentence.
      continue;
    }
    if (declared[id]?.type === "required") requiredBy.push(entry.manifest.id);
    else if (declared[id]?.type === "incompatible") incompatible.add(entry.manifest.id);
  }
  return {
    requires: requires.sort(),
    requiredBy: requiredBy.sort(),
    incompatible: [...incompatible].sort(),
  };
}
