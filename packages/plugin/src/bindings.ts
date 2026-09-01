import { AssemblyError, claim, reportDuplicates, type Claims } from "./assemble.ts";
import type { HostServices } from "./host.ts";

/**
 * KEY BINDINGS, as a composition registry — the same shape actions, panels and sections have,
 * for the same reason: a keystroke is a globally claimed name. Two plugins that both answer
 * F8 are two plugins claiming one thing, and the workspace has to say so with both ids rather
 * than let the winner depend on registration order (D5).
 *
 * A binding carries NO AUTHORITY. It is a DECLARATION — this key, this label, this scope — and
 * dispatch runs the contributing plugin's own handler, which is why a binding that mutates
 * fires a registered action at its commit point instead of writing anything itself (the plane
 * rule, `AXIOMS.md` §Axioms). What the registry buys is exactly what an undeclared listener
 * cannot give: keys that collide loudly at composition time, a table a reader can print, and a
 * key that stops answering when its plugin is disabled.
 */

/**
 * WHERE a binding applies. Declared rather than enforced by the engine, and deliberately so:
 * the surface a key belongs to is the owner's own knowledge, so the row PUBLISHES the scope —
 * the help table prints it, a reader learns it — and the handler is what honours it. An engine
 * that guessed the current surface would need a second scope oracle beside the mounted
 * renderer, which is the kind of parallel answer invariant 14 forbids.
 */
export type BindingScope = "always" | "canvas" | "composition";

/** The declaration half: what a help table, a collision report and a reader see. */
export interface BindingDef {
  /** Plugin-namespaced (`core.shell.arrange`): the row names its owner as an action name does. */
  readonly id: string;
  /** The `KeyboardEvent.key` value, verbatim (`F8`, `F9`). */
  readonly key: string;
  /** Imperative and short, as a menu row reads: "Arrange mode", "Drop-zone probe". */
  readonly label: string;
  /** Defaults to `always`; resolved once, at composition, so no reader applies the default. */
  readonly when?: BindingScope;
}

/**
 * A binding as its plugin's BROWSER half registers it: the declaration plus the handler the
 * host calls. The handler is handed the one host ref every contribution already gets, so a
 * binding that needs authority fires an action through it (`host.client`) rather than reaching
 * for a door of its own.
 *
 * Registration data is static, so a handler that needs state reads it from its own module
 * store — the same shape the zone probe's toggle has — never from React state it cannot see.
 */
export interface WebBinding extends BindingDef {
  readonly run: (host: HostServices) => void;
}

/** One plugin's registered bindings, with the roster state composition reads them under. */
export interface BindingSource {
  readonly plugin: string;
  readonly enabled: boolean;
  readonly bindings: readonly WebBinding[];
}

/**
 * A composed row: the declaration with its default applied, plus who owns it.
 *
 * `key` is the EFFECTIVE key — the declared one with this principal's override applied — and
 * `declaredKey` is what the plugin shipped. There is exactly one table: the help modal, the
 * dispatcher and the binding editor all read `key`, so nothing downstream of composition can
 * disagree about which keystroke answers, and `declaredKey` exists so the editor can say
 * "rebound from F9" and offer a reset without keeping a second copy of the defaults.
 */
export interface ComposedBinding extends Required<BindingDef> {
  readonly plugin: string;
  /** The key this row's PLUGIN declared, before any per-principal override. */
  readonly declaredKey: string;
  readonly run: (host: HostServices) => void;
}

/**
 * The rows a collision check can see: id, effective key, owner. Structural rather than
 * `ComposedBinding` because the SERVER checks with the same function and has no handlers to
 * hand it (see {@link bindingRebindRefusal}).
 */
export interface BindingKeyRow {
  readonly id: string;
  readonly key: string;
  readonly plugin?: string;
}

/**
 * WHY A REBIND CANNOT BE APPLIED, naming BOTH offenders — or null when the key is free.
 *
 * The same discipline declaration-time collisions get (`reportDuplicates`), one level later: a
 * key is a globally claimed name, so a principal moving one row onto another's key is the same
 * event as two plugins shipping the same key, and the answer is a refusal that names both
 * rather than a winner decided by evaluation order.
 *
 * ONE IMPLEMENTATION, TWO VANTAGE POINTS, and the asymmetry is honest rather than a gap. The
 * browser passes the whole effective table, because it is where registration data lives, so
 * its refusal is total. The server passes the caller's own stored overrides, because a key
 * table is browser-side registration the server has never seen — so its door refuses the
 * collisions it can see and the composition seam drops the ones it cannot (a stored override
 * whose key a plugin has since claimed loses to the declaration, `effectiveBindings`). What
 * both sides share is the WORDING: one sentence for one concept, wherever it is raised.
 */
export function bindingRebindRefusal(
  rows: readonly BindingKeyRow[],
  binding: string,
  key: string,
): string | null {
  const holder = rows.find((row) => row.id !== binding && row.key === key);
  if (holder === undefined) return null;
  const owner = holder.plugin === undefined ? "" : ` (${holder.plugin})`;
  return `key "${key}" already answers to binding "${holder.id}"${owner}; rebinding "${binding}" onto it would shadow it`;
}

/**
 * THE EFFECTIVE TABLE: declared rows with one principal's overrides applied.
 *
 * Applied HERE, at composition, and nowhere else — the seam invariant 14 asks for. A row whose
 * override lands carries the new key in `key` and its shipped key in `declaredKey`; every
 * reader downstream sees one table and never learns an override existed.
 *
 * DECLARATION WINS a contested key, and that is a refusal rather than a preference. An
 * override is stored per principal and the declarations move underneath it — a plugin ships a
 * new row, a plugin is enabled, a plugin renames its own key — so an override that would
 * shadow another row's effective key is DROPPED here instead of throwing: a stale delta must
 * never be able to take a workspace down at boot. The editor sees the drop for free, because
 * it reads the published override map beside this table and can see the row still answering
 * its default.
 *
 * Overrides are applied in the table's own order (sorted by declared key before this runs), so
 * which of two overrides claiming one key survives is a function of the table and not of
 * object-key iteration on the wire.
 */
export function effectiveBindings(
  declared: readonly ComposedBinding[],
  overrides: Readonly<Record<string, string>>,
): readonly ComposedBinding[] {
  if (Object.keys(overrides).length === 0) return declared;
  const rows: BindingKeyRow[] = declared.map((row) => ({
    id: row.id,
    key: row.key,
    plugin: row.plugin,
  }));
  return declared.map((row, index) => {
    const key = overrides[row.id];
    if (key === undefined || key === row.key) return row;
    if (bindingRebindRefusal(rows, row.id, key) !== null) return row;
    // The check reads the rows as they stand, so the very next override sees this one's key
    // taken: two deltas claiming one key leave the first applied and the second dropped.
    rows[index] = { id: row.id, key, plugin: row.plugin };
    return { ...row, key };
  });
}

/**
 * Compose the binding table, or refuse.
 *
 * Two rules, and the asymmetry between them is the point:
 *
 * - COLLISIONS are checked across every declared row, enabled or not, exactly as
 *   `assembleRoster` checks names: turning a plugin off may never mask a collision that
 *   turning it back on would resurrect.
 * - DISABLED plugins' rows are then DROPPED from the table, unlike a disabled panel or
 *   element, which stays as a row a placeholder can name (D4′). A keystroke has no surface to
 *   paint an absence on: a key that still answered would run a disabled plugin's handler, and
 *   a key listed in help that does nothing would be a lie. Nothing is lost — the row is
 *   manifest-free registration data, so re-enabling restores it whole.
 *
 * `overrides` is THE SEAM this principal's rebindings are applied at, and the only one: the
 * collision claims above are checked over DECLARED keys, because that is what a plugin author
 * owns and what a second plugin can clash with, and the deltas land afterwards
 * (`effectiveBindings`). Absent ≡ nothing rebound, which is what every caller written before
 * the editor existed means.
 */
export function composeBindings(
  sources: readonly BindingSource[],
  overrides: Readonly<Record<string, string>> = {},
): readonly ComposedBinding[] {
  const problems: string[] = [];
  const ids: Claims = new Map();
  const keys: Claims = new Map();
  const composed: ComposedBinding[] = [];

  for (const source of sources) {
    for (const binding of source.bindings) {
      claim(ids, binding.id, source.plugin);
      claim(keys, binding.key, source.plugin);
      // A row namespaced by somebody else would let one plugin publish a key under another's
      // name — the squat the `engine.` namespace check refuses for plugin ids, one level down.
      if (!binding.id.startsWith(`${source.plugin}.`)) {
        problems.push(
          `binding "${binding.id}" is declared by plugin "${source.plugin}" but is not namespaced by that plugin's id`,
        );
      }
      if (!source.enabled) continue;
      composed.push({
        id: binding.id,
        key: binding.key,
        declaredKey: binding.key,
        label: binding.label,
        when: binding.when ?? "always",
        plugin: source.plugin,
        run: binding.run,
      });
    }
  }

  reportDuplicates(ids, "binding", problems);
  reportDuplicates(keys, "binding key", problems);
  if (problems.length > 0) throw new AssemblyError(problems);

  // Sorted by DECLARED key, ties by id: this table is published vocabulary and gets printed in
  // a help modal, so its order is the reader's, never whichever plugin happened to register
  // first — and sorting before the deltas land is what makes which of two contested overrides
  // survives a function of the table rather than of wire iteration order.
  composed.sort((left, right) =>
    left.key === right.key ? (left.id < right.id ? -1 : 1) : left.key < right.key ? -1 : 1,
  );
  return effectiveBindings(composed, overrides);
}
