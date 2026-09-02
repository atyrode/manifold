import { ITEM_KINDS, type ItemKind, type PluginRoster } from "@manifold/protocol";

/**
 * THE LABEL VOCABULARY: one map from an item kind to the word a person reads, and
 * nothing else in the tree may hold a second one.
 *
 * Three tables used to answer this question and they disagreed — a carry's fallback name
 * said "view", the icon vocabulary said "canvas", and the drop refusals said "A canvas" —
 * so the same object was called three things depending on which surface spoke. That is
 * not a bug to fix in place: it is what having no canon costs, and it comes back the
 * moment a second table is allowed to exist. `verify:axioms` S12 asserts this is the ONLY
 * kind→noun map in the tree, that its keys are exactly `ITEM_KINDS`, and that each value
 * is the key's own canonical word.
 *
 * FLOOR KINDS ONLY, by construction. A CONTRIBUTED kind takes its manifest title — the
 * plugin owns its own word, the floor owns the grammar — which is why this table can stay
 * closed while the kind vocabulary stays open, and why `canvas` and `composition` left it
 * when the discipline roster opened (#110): they are `core.canvas`'s and
 * `core.compositions`' declared titles now, read through the same door a contributed
 * element kind's word comes through.
 */
export const ITEM_NOUNS: Readonly<Record<ItemKind, string>> = {
  terminal: "terminal",
  tile: "tile",
  panel: "panel",
  structure: "structure",
};

const FLOOR_NOUNS: Readonly<Record<string, string>> = ITEM_NOUNS;

/**
 * What to call one item kind: the floor's word for a floor kind, the declaring plugin's
 * manifest title for a contributed one — a container DISCIPLINE or an element type — and
 * a truthful generic for a kind this build has never heard of.
 *
 * That last case is the whole reason this function cannot throw. A container whose
 * discipline is uninstalled still has a row, still has a name, and still appears in the
 * index; the refusal it earns is `unknown_discipline`, spoken in a sentence about an
 * "item", never a crash in the sidebar that was only trying to draw it (#110).
 */
export function itemNoun(kind: string, roster: PluginRoster): string {
  const floor = FLOOR_NOUNS[kind];
  if (floor !== undefined) return floor;
  for (const entry of roster) {
    for (const discipline of entry.manifest.contributes.disciplines ?? []) {
      if (discipline.id === kind) return discipline.title.toLowerCase();
    }
    for (const element of entry.manifest.contributes.elements) {
      if (element.type === kind) return element.title.toLowerCase();
    }
  }
  return "item";
}

/** The same word in the subject position of a sentence: "A canvas", "An item". */
export function itemNounPhrase(kind: string, roster: PluginRoster): string {
  const noun = itemNoun(kind, roster);
  return `${/^[aeiou]/.test(noun) ? "An" : "A"} ${noun}`;
}

/** Every floor kind carries a noun; a kind added to the algebra cannot ship without one. */
const nounsAreTotal: Exclude<ItemKind, keyof typeof ITEM_NOUNS> extends never ? true : never = true;
void nounsAreTotal;
void ITEM_KINDS;
