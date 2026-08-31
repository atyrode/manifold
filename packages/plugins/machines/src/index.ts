import type { PluginManifest } from "@manifold/protocol";

/**
 * The machine inventory, as a plugin. It is the smallest honest example of what a section IS
 * after the conversion: a manifest that declares one slot, and a web half that answers its
 * own question through `host.client` — no shell state, no props from the sidebar, nothing the
 * sidebar has to know about machines.
 *
 * It declares no capabilities and no actions this wave. Enrollment (`POST /api/machines`,
 * `machines:mint`) is still a bespoke route; AXIOMS.md §Roadmap puts "machines enrollment
 * actions → core.machines" in the conversion inventory, and that is where the caps arrive.
 */
export const machinesManifest: PluginManifest = {
  id: "core.machines",
  version: "1.0.0",
  title: "Machines",
  description: "Lists the enrolled machines with live online state and births terminals on them.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [{ id: "machines", title: "Machines", order: 20 }],
    elements: [],
    tools: [],
    events: [],
  },
};
