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

/** A composed row: the declaration with its default applied, plus who owns it. */
export interface ComposedBinding extends Required<BindingDef> {
  readonly plugin: string;
  readonly run: (host: HostServices) => void;
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
 */
export function composeBindings(sources: readonly BindingSource[]): readonly ComposedBinding[] {
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

  // Sorted by key, ties by id: this table is published vocabulary and gets printed in a help
  // modal, so its order is the reader's, never whichever plugin happened to register first.
  return composed.sort((left, right) =>
    left.key === right.key ? (left.id < right.id ? -1 : 1) : left.key < right.key ? -1 : 1,
  );
}
