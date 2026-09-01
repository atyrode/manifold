import { type PluginManifest } from "@manifold/protocol";

/**
 * `core.debug` — THE DIAGNOSTIC SEAT: one plugin holding the family of read-only probes this
 * workspace can be looked at through.
 *
 * ONE SEAT, not one per probe, and that is roster restraint rather than tidiness (AGENTS.md
 * §Conventions): every seat in the box is a thing a stranger's agent must read before it can
 * tell what manifold is, so "the diagnostics" is one line in that list however many instruments
 * hang off it. Two hang off it today:
 *
 *   the INSPECTOR (F10) — point at anything and be told what it is, where it lives
 *     (`manifold://`), who owns it, which doors it reaches and who is in it. A join of three
 *     things the page already holds: the DOM's own `data-*` declarations (invariant 12), the
 *     live assembly, and the resolve door.
 *   the ZONE PROBE (F9) — the drop resolver's answer painted across a tile area, sampled from
 *     the real `resolveTileAim` so the picture cannot drift from the behaviour.
 *
 * THE ZONE PROBE CAME FROM `core.shell`, and that move is the point of this plugin existing. A
 * probe never belonged to the shell: the shell owns the workspace frame, and a debug painting of
 * the drop geometry is an instrument you bring TO the frame. Its key row moved here verbatim —
 * same key, same label, same handler, same `always` scope — so the relocation is observable only
 * as the owner column of the sidebar's key table, and disabling `core.debug` now takes F9 and
 * F10 away together, which is exactly what "the diagnostics are off" should mean.
 *
 * IT CONTRIBUTES NO PANELS, SECTIONS, ELEMENTS, TOOLS OR EVENTS, and declares no capabilities.
 * Both probes are read-only: the inspector dispatches nothing (its two affordances are the
 * clipboard and the host's own navigation), and the zone probe is `pointer-events: none` paint.
 * What it registers has no manifest vocabulary — two BINDINGS and one workspace overlay slot —
 * so, exactly like `core.uri`, the manifest exists to make the plugin nameable, disableable and
 * visible in the roster.
 *
 * It publishes `vantage.tool = "inspect"` while the inspector is armed, because a mode a
 * collaborator cannot observe and an agent cannot read back is a private capability (A2). That
 * id is deliberately NOT a `contributes.tools` row: a contributed tool is a canvas toolbar
 * mode, and the inspector is not one.
 */
export const debugManifest: PluginManifest = {
  id: "core.debug",
  version: "1.0.0",
  title: "Diagnostics",
  description: "Read-only probes: the F10 inspector and the F9 drop-zone probe.",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};
