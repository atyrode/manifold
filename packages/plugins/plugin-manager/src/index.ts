import type { PluginManifest } from "@manifold/protocol";

/**
 * The plugin manager: a UI over the composition, and nothing more.
 *
 * THE MECHANISM IS NOT THIS PLUGIN'S, and that has not changed. This plugin used to own
 * `setEnabled` and carry `essential: true` to protect it — a plugin made permanently
 * undisableable so that the mechanism inside it could not be switched off. That was the
 * correct diagnosis of a real self-lockout and the wrong cure (ADR 0013 §11): the enablement
 * door belongs to the engine, published as a builtin roster row
 * (`engine.plugins.setEnabled`), where no toggle can reach it. It is still there, still a
 * builtin row, and still reachable over the API by any principal holding `plugins:manage`
 * even if this UI were gone tomorrow. Nothing here administers anything; it presses a door it
 * does not own.
 *
 * THE SEAT IS ESSENTIAL, and that is new (issue #91). The ledger of what is on and off is a
 * rail non-negotiable: it is the one place a reader can see which plugins this workspace
 * composed, which ones are off, why a row refuses to move, and what a disable would take with
 * it. A workspace whose plugin list can itself be switched off has hidden its own recovery
 * surface — the state you would be in is exactly the state where you most need to read it,
 * and the way back would be an API call typed by hand against a server whose roster you can
 * no longer see.
 *
 * The distinction is the whole point, and it is why this is not a return to the
 * self-protecting-plugin mistake: `essential` here protects the LEDGER, not the MECHANISM.
 * The old flag was a plugin defending its own code because the door lived inside it — remove
 * the plugin and the capability was gone. This flag defends a VIEW whose absence costs no
 * authority at all: every door it opens stays open without it, and a stranger's shell that
 * decides a rail needs no plugin ledger disables `core.shell` and ships its own, exactly as
 * A1 promises. What may not happen is a workspace that still draws its rail while the one
 * ledger of its own composition is missing from it.
 *
 * The refusal itself is the ENGINE's, not this manifest's: `essential: true` is a declaration
 * the engine's door reads and answers with the `essential` refusal class, so the lock a reader
 * sees on this row is drawn from the same roster field every other locked row is drawn from.
 */
export const pluginManagerManifest: PluginManifest = {
  id: "core.plugins",
  version: "3.0.0",
  title: "Plugins",
  description: "Lists the workspace composition and drives the engine's enablement door.",
  capabilities: [],
  essential: true,
  contributes: {
    panels: [],
    /**
     * A PLAIN row that opens a modal, clustered beside the key table's row at the rail's
     * foot: the ledger is a whole screen (search, filter, categories, dependencies both ways)
     * and a 240px rail can only ever show a slice of one. `cluster: "utility"` is this row
     * saying "I belong beside whoever else declares this word" — no floor file, panel or
     * engine registry lists the cluster's members, so the pairing survives either row being
     * disabled, rearranged or replaced.
     */
    sections: [
      { id: "plugins", title: "Plugins", order: 51, presentation: "plain", cluster: "utility" },
    ],
    elements: [],
    tools: [],
    events: [],
  },
};
