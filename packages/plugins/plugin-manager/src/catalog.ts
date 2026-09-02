import type { PluginRosterEntry } from "@manifold/protocol";

/**
 * THE CATALOG: the roster as a READER navigates it, and nothing more.
 *
 * The roster is the one published plugin list (`GET /api/plugins`, pushed on the connection
 * frame) and this module never becomes a second one — it derives a VIEW of it: grouped by
 * where a row came from, narrowed by a search word, narrowed again by on/off. Every function
 * here takes the roster it is asked about and returns fresh arrays, so there is no cached
 * copy of the list to disagree with the server's (invariant 14: one list, one door).
 *
 * It lives beside the component instead of inside it because grouping, matching and
 * dependency inversion are POLICY, and policy that can only be exercised by mounting React
 * is policy nobody tests (AGENTS.md §Conventions). Everything below is pure and total: no
 * `undefined` returns, no throwing on an id the roster has never heard of, and an empty
 * roster answers with empty structure rather than a special case the caller must remember.
 */

/**
 * A CATEGORY is the answer to "what kind of row is this", and there are three.
 *
 * `source` alone cannot answer it, and that was the first shape of this file's mistake: the
 * protocol's closed set separates the ENGINE's builtin rows from everything the composition
 * assembled, so every shipped seat — the shell, the canvas, the index, this manager — landed
 * under "Installed plugins" beside a stranger's plugin, which is exactly the distinction issue
 * #91 asked the modal to draw. So the axis is the row's own NAMESPACE, which is where "shipped
 * with manifold" is actually written: `engine.` is reserved for the engine's doors and `core.`
 * is reserved for the seats in the box, both refused to anybody else by assembly.
 *
 * A closed local vocabulary rather than a derived string, so the titles table and the display
 * order below are both total over it and a fourth kind is a compile error here.
 */
export const PLUGIN_CATEGORIES = ["engine", "core", "installed"] as const;
export type PluginCategoryKind = (typeof PLUGIN_CATEGORIES)[number];

export interface PluginCategory {
  readonly kind: PluginCategoryKind;
  readonly title: string;
  readonly rows: readonly PluginRosterEntry[];
}

/**
 * WHICH KIND a row is. `source` decides the engine's own rows, because a builtin row is one by
 * publication rather than by name; the reserved `core.` namespace decides the rest. Total: an
 * id under neither namespace is a plugin somebody installed, which is the only remaining thing
 * it can be.
 */
export function pluginCategoryKind(entry: PluginRosterEntry): PluginCategoryKind {
  if (entry.source === "builtin") return "engine";
  return entry.manifest.id.startsWith(CORE_NAMESPACE_PREFIX) ? "core" : "installed";
}

const CORE_NAMESPACE_PREFIX = "core.";

/**
 * The category's words, keyed by the closed kind set — so a fourth kind cannot be added
 * without this table refusing to compile. A plugin list that silently drops a whole class of
 * rows because nobody taught it a new word is the failure this shape makes impossible, and it
 * is the same guard `PURGE_TARGET_LABELS` uses in `web.tsx` for the same reason.
 *
 * "Core seats" rather than "core plugins": `seat` is the canon word for a declared occupancy
 * (REGISTRY.md §Lexicon), and what a reader is looking at in those rows is the boxes the
 * default distribution fills.
 */
const CATEGORY_TITLES: Readonly<Record<PluginCategoryKind, string>> = {
  engine: "Engine doors",
  core: "Core seats",
  installed: "Installed plugins",
};

/**
 * The DISPLAY order, as a total function rather than a list. A switch with a `never` guard is
 * the house's exhaustiveness idiom, and it buys the same thing here that the titles table buys:
 * a kind added above is a compile error in this file, not a category that quietly sorts last.
 *
 * Engine doors come first because they are the rows a reader cannot change — knowing what is
 * fixed is what makes the rest of the list readable — then the seats in the box, then whatever
 * this workspace had installed into it.
 */
function categoryRank(kind: PluginCategoryKind): number {
  switch (kind) {
    case "engine":
      return 0;
    case "core":
      return 1;
    case "installed":
      return 2;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * What the reader may narrow the list down to. `all` is a real member rather than the
 * absence of a filter: the control is a set of three chips a reader moves between, and a
 * state that has to be spelled as "no filter" cannot be one of them.
 */
export const PLUGIN_FILTERS = ["all", "enabled", "disabled"] as const;
export type PluginFilter = (typeof PLUGIN_FILTERS)[number];

/** The filter chips' words, keyed by the closed set so the chip row cannot fall behind it. */
export const PLUGIN_FILTER_LABELS: Readonly<Record<PluginFilter, string>> = {
  all: "All",
  enabled: "On",
  disabled: "Off",
};

function matchesFilter(entry: PluginRosterEntry, filter: PluginFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "enabled":
      return entry.enabled;
    case "disabled":
      return !entry.enabled;
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

/**
 * The search, over the three fields a reader could plausibly be typing from: the id they saw
 * in a refusal message, the title they saw in the rail, and the description that is the only
 * text saying what an unfamiliar plugin is for. Substring rather than prefix, because a
 * reader looking for `core.plugins` types "plug", and case-insensitive because an id is
 * lowercase while a title is not.
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
    manifest.description.toLowerCase().includes(needle)
  );
}

/**
 * Rows within a category read alphabetically BY TITLE, because the title is what the reader
 * is scanning; the id breaks ties. Two plugins may legitimately share a title — ids are
 * namespaced by authority precisely so two authors can both ship "Terminals" (D5) — and a
 * comparison that answered "equal" there would let the list reorder itself between renders
 * over nothing.
 */
function compareRows(left: PluginRosterEntry, right: PluginRosterEntry): number {
  const byTitle = left.manifest.title.localeCompare(right.manifest.title);
  return byTitle !== 0 ? byTitle : left.manifest.id.localeCompare(right.manifest.id);
}

/**
 * THE derivation: roster in, ordered categories of ordered rows out.
 *
 * A category with no surviving row is DROPPED rather than rendered empty. A heading over
 * nothing reads as "there are no core seats in this workspace", which would be a lie about
 * the workspace rather than a fact about the search; the component says "nothing matches"
 * once, about the whole list, where it is true. That also makes the empty roster answer
 * `[]` by construction instead of by a guard nobody would remember to write.
 */
export function pluginCatalog(
  roster: readonly PluginRosterEntry[],
  query: string,
  filter: PluginFilter,
): readonly PluginCategory[] {
  const needle = query.trim().toLowerCase();
  const grouped = new Map<PluginCategoryKind, PluginRosterEntry[]>();
  for (const entry of roster) {
    if (!matchesFilter(entry, filter) || !matchesQuery(entry, needle)) continue;
    const kind = pluginCategoryKind(entry);
    const bucket = grouped.get(kind);
    if (bucket === undefined) grouped.set(kind, [entry]);
    else bucket.push(entry);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => categoryRank(left) - categoryRank(right))
    .map(([kind, rows]) => ({
      kind,
      title: CATEGORY_TITLES[kind],
      rows: rows.sort(compareRows),
    }));
}

/**
 * What a plugin needs, and what needs it. Ids only: a title is the assembly's answer
 * (`host.assembly.pluginTitle`), and a policy module that resolved them would be a second
 * name table for plugins.
 */
export interface PluginRelations {
  readonly needs: readonly string[];
  readonly neededBy: readonly string[];
}

/**
 * BOTH DIRECTIONS of the dependency relation, derived from the roster's own manifests.
 *
 * The forward direction is a manifest read; the reverse direction exists nowhere in the
 * protocol and can only be computed by asking every other row what it declares — which is
 * exactly why it belongs here and not in a component. It is also the direction a reader
 * needs before pressing a toggle: "what does this need" explains a refusal that already
 * happened, while "what needs this" is the blast radius of a disable that has not happened
 * yet, and a ledger that only shows the first one lets someone turn off a plugin three
 * others were standing on.
 *
 * Only `required` counts. `optional` refuses nothing by protocol definition — it exists so a
 * client can explain a DEGRADED experience — so listing it under "needs" would tell a reader
 * something breaks when nothing does. `incompatible` is not a need at all but its opposite,
 * and the roster already surfaces it where it matters, as the `incompatible_dependency`
 * refusal class on the row itself. `after` is deliberately NOT read: the protocol keeps
 * requirement and ORDER on separate axes ("I need X" and "put me after X" are different
 * sentences), and folding sequence into this list would re-conflate the two things that
 * split was made to keep apart.
 *
 * Ids are returned verbatim, including ones no roster row carries: a `required` dependency
 * that was never composed is the whole content of a `missing_dependency` refusal, so
 * dropping unresolvable ids would hide the one case a reader most needs to see. Sorted, so
 * the block is stable across renders and across servers.
 */
export function pluginDependencies(
  roster: readonly PluginRosterEntry[],
  id: string,
): PluginRelations {
  const needs: string[] = [];
  const neededBy: string[] = [];
  for (const entry of roster) {
    const declared = entry.manifest.dependencies;
    if (declared === undefined) continue;
    if (entry.manifest.id === id) {
      for (const [target, dependency] of Object.entries(declared)) {
        if (dependency?.type === "required") needs.push(target);
      }
      // A row is never its own dependent, so the self row is done here: reading it for the
      // reverse direction could only ever produce "needs itself", which is not a sentence.
      continue;
    }
    if (declared[id]?.type === "required") neededBy.push(entry.manifest.id);
  }
  return { needs: needs.sort(), neededBy: neededBy.sort() };
}
