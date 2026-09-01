import { type PluginManifest } from "@manifold/protocol";

/**
 * `core.commands` — the workspace's own doors, keys and rooms, in one searchable surface
 * (issue #129).
 *
 * IT DECLARES NO VOCABULARY OF ITS OWN, and that is the whole roster-restraint argument for a
 * new seat rather than a new feature. Everything this plugin shows is a registry the engine
 * already composed and already publishes to every plugin alike (`host.assembly`):
 *
 *   DOORS       every composed action, with the caps it costs — `roster().actions`
 *   KEYS        every composed binding, with the keystroke it answers to — `assembly.bindings`
 *   ROOMS       every container in the workspace index — `client.index()`
 *
 * So it is not an opinionated feature in the box: it is the universal door-opener, and its
 * data model is the composition itself. Add a plugin and its doors and keys appear here for
 * free; disable one and they leave, because composition dropped them upstream. A palette that
 * kept its own list of commands would be exactly the second roster invariant 14 forbids —
 * this one cannot have one, because it declares nothing.
 *
 * WHAT IT CONTRIBUTES is one binding and one workspace overlay, and no seat in the rail. A
 * command menu is reached by its key from wherever the viewer is standing — including the
 * workspace root, where no container is mounted — which is what the workspace overlay channel
 * is for. A rail row would be a second door onto one surface (invariant 14) and would need a
 * mark the engine's closed control vocabulary has no neutral verb for; the key table lists
 * this plugin's row like every other, which is where a reader learns the keystroke.
 *
 * WHAT IT REFUSES TO DO is knock on a door it cannot fill. A composed action publishes its
 * input SCHEMA, and a schema with required properties needs arguments only the affordance
 * that owns the subject can supply — a rename knows which terminal, this list does not. So a
 * row is runnable when the door needs nothing, and every other row is a DIRECTORY ENTRY that
 * says what it would need. Guessing arguments from a search box would be a second, sniffing
 * answer to "how is this door called", sitting beside the published contract.
 *
 * `cmdk` is the list behind it, pinned and boring
 * (`docs/decisions/2026-09-01-cmdk-command-menu.md`).
 */
export const commandsManifest: PluginManifest = {
  id: "core.commands",
  version: "1.0.0",
  title: "Commands",
  description:
    "One searchable surface over the composition: every door with the authority it costs, every key with the stroke it answers to, and every container in the index.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [],
  },
};

/**
 * The binding id, built from the manifest id rather than spelled, exactly as an action name is:
 * the row, the key table and this package's own registration cannot drift from the declaration.
 */
export const COMMANDS_OPEN_BINDING = `${commandsManifest.id}.open`;
