import type { PluginRoster, SettingDef, SettingRef, SettingValue } from "@manifold/protocol";

/**
 * PLUGIN SETTINGS, as a composition registry — the same shape actions, panels, sections and
 * key bindings have, and for the same reason: a preference is DECLARED in a manifest, claimed
 * under its plugin's namespace, and given meaning at exactly one seam.
 *
 * The seam is the whole design. A declaration carries a `default`; a principal carries a
 * DELTA; the effective table is the join, computed here and nowhere else, so no reader
 * downstream ever has to know that an override existed or what the shipped value was. That is
 * the discipline `effectiveBindings` keeps one file over, and it is what lets a plugin change
 * its own default, be disabled, or leave the roster entirely without anybody rewriting a
 * stored map.
 *
 * The FIRST consumer is the sidebar: a section may declare that it is a preference
 * (`SectionDef.setting`), and a section whose setting reads false is dropped
 * ({@link visibleSections}). Dropped, not marked — a preference is not a disable, so there is
 * no tombstone, no placeholder and no seat kept warm. A disabled plugin's row is an absence
 * the workspace owes the reader an explanation for (D4′); a row somebody turned off is one
 * they already know about, and explaining it back to them would be the product arguing.
 */

/**
 * A SETTING'S PUBLISHED NAME, built the one way it is ever built. The pair rule again — a
 * plugin can only name things inside its own namespace — spelled here for settings exactly as
 * `panelRefId` spells it for panels, so no call site composes the string by hand.
 *
 * It answers the wire's own key type, so a ref composed here indexes a stored value map
 * without a cast: what a legal key looks like is the protocol's statement, and this is the
 * function that satisfies it.
 */
export function settingRefId(plugin: string, setting: string): SettingRef {
  return `${plugin}.${setting}`;
}

/**
 * A composed row: the declaration, its owner, and the value it EFFECTIVELY reads for the
 * principal whose delta it was composed with. `declared` sits beside `value` for the same
 * reason `ComposedBinding.declaredKey` sits beside `key` — an editor has to be able to tell
 * "this is what the plugin ships" from "this is what you chose", and a table that only carried
 * the answer could not.
 */
export type ComposedSetting = SettingDef & {
  readonly ref: SettingRef;
  readonly plugin: string;
  readonly declared: SettingValue;
  readonly value: SettingValue;
};

/**
 * THE EFFECTIVE TABLE: every declared setting in the roster, with one principal's values
 * applied.
 *
 * Every roster row contributes, ENABLED OR NOT, and that asymmetry against `composeBindings`
 * is deliberate. A key that still answered would run a disabled plugin's handler; a preference
 * answers nobody — it is inert data a manager lists and a re-enabled plugin picks straight back
 * up. Dropping a disabled plugin's declarations would make its pane in the manager go blank
 * exactly when a reader is deciding whether to turn it back on.
 *
 * A stored value whose declaration nobody carries is IGNORED here rather than pruned from the
 * store, the same way a stale rebinding loses to a declaration: a plugin turned off for a week
 * must find its preferences intact, and a delta must never be able to take a workspace down at
 * boot.
 *
 * Sorted by ref, so the table a manager prints is the reader's order and never whichever
 * plugin the roster happened to list first.
 */
export function composeSettings(
  roster: PluginRoster,
  values: Readonly<Record<string, SettingValue>> = {},
): readonly ComposedSetting[] {
  const composed: ComposedSetting[] = [];
  for (const entry of roster) {
    for (const setting of entry.manifest.contributes.settings ?? []) {
      const ref = settingRefId(entry.manifest.id, setting.id);
      const stored = values[ref];
      composed.push({
        ...setting,
        ref,
        plugin: entry.manifest.id,
        declared: setting.default,
        value: (
          setting.kind === "boolean"
            ? typeof stored === "boolean"
            : setting.values.some((value) => value.id === stored)
        )
          ? stored!
          : setting.default,
      });
    }
  }
  composed.sort((left, right) => (left.ref === right.ref ? 0 : left.ref < right.ref ? -1 : 1));
  return composed;
}

/**
 * THE ONE ROW RULE: a section that names a setting survives composition only while that setting
 * reads true.
 *
 * Generic over the row so the engine's registry, the browser's join and a test's fixture all go
 * through this function rather than each writing `if (value === false) continue` in its own
 * loop — one rule, one implementation, and a row's fate is a property of the composition rather
 * than of whichever list happened to be built last (invariant 14).
 *
 * A section naming a setting NO row answers is KEPT. Assembly already refuses a manifest that
 * gates a row on a setting it does not contribute, so the only way to reach this case is a
 * roster that no longer carries the plugin at all — and then the section is gone with it. A
 * preference cannot make a row disappear by going missing; only by reading false.
 */
export function visibleSections<T extends { readonly plugin: string; readonly setting?: string }>(
  sections: readonly T[],
  settings: readonly ComposedSetting[],
): readonly T[] {
  if (sections.every((section) => section.setting === undefined)) return sections;
  const byRef = new Map(settings.map((setting) => [setting.ref, setting.value]));
  return sections.filter((section) => {
    if (section.setting === undefined) return true;
    return byRef.get(settingRefId(section.plugin, section.setting)) !== false;
  });
}

/**
 * WHAT ONE DECLARED SETTING READS for this principal, or null when nothing in the table
 * declares it.
 *
 * The reader a PLUGIN uses on its own settings, and the reason it exists rather than each
 * consumer indexing the table itself: the shipped default already lives in the manifest, so a
 * consumer that wrote `?? true` beside its declaration would be spelling the default twice and
 * would go on answering the old one after the manifest changed. `null` is honestly different
 * from `false` — "nobody declares this" is a bug in the caller, not a preference — and a
 * caller that treats absence as permission writes `!== false`, which is the same sentence
 * `visibleSections` makes about a row.
 *
 * Not every consumer is a section: a row may gate PART of itself, which the engine cannot do
 * for it because the engine composes rows and knows nothing of what is inside one.
 */
export function settingValue(
  settings: readonly ComposedSetting[],
  plugin: string,
  setting: string,
): SettingValue | null {
  const ref = settingRefId(plugin, setting);
  return settings.find((row) => row.ref === ref)?.value ?? null;
}

/**
 * WHY A SETTING CANNOT BE WRITTEN, naming both the plugin and the setting — or null when the
 * write may proceed.
 *
 * The door's whole legality check, and it is a check against the ASSEMBLY rather than against
 * the store: a value is meaningful only as an answer to a declaration, so a write to a name no
 * manifest declares is refused instead of stored as a delta nothing would ever read. That is
 * also what bounds the map without a quota — a principal can hold an opinion about exactly the
 * settings their workspace composes.
 *
 * One implementation, both vantage points, exactly as `bindingRebindRefusal` is: the server's
 * door raises it against the roster it composed, and a client that wants to explain the same
 * refusal before dispatching raises it against the roster it was pushed.
 */
export function settingWriteRefusal(
  roster: PluginRoster,
  plugin: string,
  setting: string,
): string | null {
  const entry = roster.find((row) => row.manifest.id === plugin);
  if (entry === undefined) {
    return `no plugin "${plugin}" is composed, so it declares no setting "${setting}"`;
  }
  const declared = entry.manifest.contributes.settings ?? [];
  if (!declared.some((row) => row.id === setting)) {
    return `plugin "${plugin}" contributes no setting "${setting}"`;
  }
  return null;
}
