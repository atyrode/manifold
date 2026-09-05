import type { PluginManifest } from "@manifold/protocol";

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │  THROWAWAY SPIKE PLUGIN — NEVER MERGE. Evidence for manifold #160 and for            │
 * │  atyrode/code's transition record; the durable output is docs/spikes/code-launcher.md. │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `code.launcher-spike` is the smallest thing that can stand in for atyrode/code's launcher
 * half: three dials fed from a hard-coded five-row slice of code's catalog, a machine picker
 * read through `core.machines.list`, and one Launch that opens a terminal on the chosen
 * machine and types a line into it once the shell is ready. Everything it does goes through
 * doors a stranger's agent already has; it declares no action of its own and holds no
 * authority beyond the device bearer it is handed.
 *
 * `capabilities: []` is honest: the manifest ceiling bounds ACTIONS this plugin declares, and
 * it declares none. Opening a terminal is channel traffic under the caller's own caps.
 */
export const codeLauncherSpikeManifest: PluginManifest = {
  id: "code.launcher-spike",
  version: "0.0.0-spike",
  title: "Code launcher (spike)",
  description:
    "THROWAWAY sizing evidence for #160: lane/model/thinking dials, a machine picker, and a launch that opens a terminal and types into it.",
  capabilities: [],
  contributes: {
    panels: [{ id: "launcher", title: "Code launcher (spike)" }],
    /*
      A seat between the sidebar (100) and the container view (200), so a FRESH workspace
      shows the dials without anybody editing a layout. A principal who has already arranged
      their workspace keeps their tree (ADR 0017 §3) and never sees this seat — measured in
      the spike record, because that is exactly what happens to a plugin installed later.
    */
    seats: [{ panel: "launcher", order: 150, ratio: 0.3 }],
    sections: [],
    elements: [],
    tools: [],
    events: [],
  },
};

/** Where the seat's full panel id is spelled, once. */
export const LAUNCHER_PANEL_ID = `${codeLauncherSpikeManifest.id}.launcher`;
