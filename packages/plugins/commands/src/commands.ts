import type { ComposedBinding } from "@manifold/plugin";
import { rosterDisciplines } from "@manifold/protocol";
import type { ActionSummary, Cap, IndexEntry, PluginRoster } from "@manifold/protocol";

/**
 * THE PROJECTION: three composed registries in, one flat list of rows out.
 *
 * Pure and its own module because it is the whole policy of this plugin — which rows exist,
 * which of them can be run right now, and what a refusal SAYS — and policy that decides
 * authority-shaped questions belongs somewhere a test can ask it directly rather than inside a
 * component callback (AGENTS.md §Conventions). The renderer below it does nothing but paint
 * what this returns.
 */

/** What a row addresses. Each kind has exactly one verb, named on {@link Command.verb}. */
export type CommandKind = "door" | "key" | "container";

export interface Command {
  /** Unique across every group: the kind and the thing it addresses. */
  readonly id: string;
  readonly kind: CommandKind;
  /** The imperative a reader reads: an action's title, a binding's label, a container's name. */
  readonly title: string;
  /** Who owns it — a plugin's title, or the container's discipline. */
  readonly owner: string;
  /** The thing addressed: a full action name, a binding id, a container id. */
  readonly target: string;
  /** The keystroke that also reaches this row, when one does. */
  readonly stroke: string | null;
  /**
   * WHY THIS ROW CANNOT BE RUN, or null when it can. Rendered beside the row and never
   * swallowed: a door a reader cannot open is shown, disabled, with the reason — see
   * {@link doorRefusal}.
   */
  readonly refusal: string | null;
  /** The container the viewer is already standing in reads differently from the rest. */
  readonly here: boolean;
  /**
   * What the list filters, keys and highlights on. It carries {@link Command.id}, not the bare
   * target, because a binding id and an action name are namespaced the same way and CAN be the
   * same string — `core.index.read` is a legal spelling of both — and two rows sharing one
   * value makes the list select the wrong one.
   */
  readonly value: string;
}

export interface CommandsInput {
  readonly roster: PluginRoster;
  readonly bindings: readonly ComposedBinding[];
  readonly containers: readonly IndexEntry[];
  /**
   * THE CALLER'S OWN CAPS, or null when this device has not joined a room and therefore has
   * not been told any. Null is UNKNOWN and never DENIED: a workspace root has no room, so
   * `selfCaps()` is legitimately empty there, and painting every door as forbidden because
   * nobody has been asked yet would be a confident lie about somebody's authority.
   */
  readonly caps: readonly Cap[] | null;
  readonly containerId: string | null;
  readonly pluginTitle: (id: string) => string | null;
}

/** The properties a published input schema insists on; empty when it insists on nothing. */
function requiredInputs(action: ActionSummary): readonly string[] {
  const required = action.input["required"];
  return Array.isArray(required) ? required.filter((name) => typeof name === "string") : [];
}

/**
 * WHY THIS DOOR CANNOT BE OPENED FROM HERE, in the dispatcher's own order.
 *
 * The ACTION DENIAL LADDER is monotonic and public (`ACTION_DENIAL_RULES`): the plugin must be
 * enabled, the caller must hold every declared cap, and the arguments must parse. This walks
 * the same rungs in the same order BEFORE knocking, so what a reader is told matches what the
 * server would have answered, and a row never reports the second problem while hiding the
 * first. Nothing here is a second authority check — the door still decides; this decides what
 * a list is honest to offer.
 *
 * The last rung is the one the ladder cannot see from here and the palette cannot pass: a
 * schema with required properties needs a SUBJECT, and a list of every door in the workspace
 * is precisely the surface that has no subject in hand.
 */
export function doorRefusal(
  action: ActionSummary,
  pluginEnabled: boolean,
  pluginTitle: string,
  caps: readonly Cap[] | null,
): string | null {
  if (!pluginEnabled && action.cleanup !== true) return `${pluginTitle} is disabled`;
  if (caps !== null && !caps.includes("*")) {
    const missing = action.caps.filter((cap) => cap !== "*" && !caps.includes(cap));
    if (action.caps.includes("*") && !caps.includes("*")) return "requires full authority";
    if (missing.length > 0) return `requires ${missing.join(", ")}`;
  }
  const needs = requiredInputs(action);
  if (needs.length > 0) return `needs ${needs.join(", ")} — open it where its subject is`;
  return null;
}

/**
 * Every row, grouped in reading order: doors, then keys, then rooms. Within a group the order
 * is the reader's — alphabetical by what they see — because these three registries arrive in
 * three different orders (roster order, key order, index sort order) and a list whose rows
 * move when a plugin is registered somewhere else is a list nobody can learn.
 */
export function composeCommands(input: CommandsInput): readonly Command[] {
  const rows: Command[] = [];
  const disciplines = rosterDisciplines(input.roster);

  for (const entry of input.roster) {
    const owner = entry.manifest.title;
    for (const action of entry.actions) {
      rows.push({
        id: `door:${action.name}`,
        kind: "door",
        title: action.title,
        owner,
        target: action.name,
        stroke: null,
        refusal: doorRefusal(action, entry.enabled, owner, input.caps),
        here: false,
        value: `${action.title} ${owner} door:${action.name}`,
      });
    }
  }

  for (const binding of input.bindings) {
    const owner = input.pluginTitle(binding.plugin) ?? binding.plugin;
    rows.push({
      id: `key:${binding.id}`,
      kind: "key",
      title: binding.label,
      owner,
      target: binding.id,
      stroke: binding.key,
      refusal: null,
      here: false,
      value: `${binding.label} ${owner} key:${binding.id}`,
    });
  }

  for (const entry of input.containers) {
    if (entry.kind !== "container") continue;
    const container = entry.container;
    /*
      The discipline's own DECLARED title, read off the roster the same way everything else
      here is (`rosterDisciplines`) — never a table of nouns kept in this package, which is the
      one thing the lexicon law allows exactly one of in the tree (S12). An uninstalled
      discipline has no declaration, and the wire value is then the honest thing to print.
    */
    const owner = disciplines.get(container.discipline)?.title ?? container.discipline;
    rows.push({
      id: `container:${container.id}`,
      kind: "container",
      title: container.name,
      owner,
      target: container.id,
      stroke: null,
      refusal: null,
      here: container.id === input.containerId,
      value: `${container.name} ${owner} container:${container.id}`,
    });
  }

  const rank: Record<CommandKind, number> = { door: 0, key: 1, container: 2 };
  return rows.sort((left, right) =>
    left.kind === right.kind
      ? left.title.localeCompare(right.title) || left.target.localeCompare(right.target)
      : rank[left.kind] - rank[right.kind],
  );
}

/** The heading each group wears, and the whole of what the renderer knows about grouping. */
export const GROUP_HEADINGS: Record<CommandKind, string> = {
  door: "Doors",
  key: "Keys",
  container: "Containers",
};
