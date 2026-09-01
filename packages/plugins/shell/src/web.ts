import type { WebBinding } from "@manifold/plugin";
import { toggleArranging, toggleZoneProbe } from "@manifold/plugin/ui";
import { shellManifest } from "./index.ts";

/**
 * The shell's BROWSER half: the keys the workspace itself answers to.
 *
 * A binding row is a DECLARATION — key, label, scope — and the handler beside it is the shell's
 * own; the row holds no authority, so anything that mutates goes through a registered action at
 * its commit point (`@manifold/plugin`'s `BindingDef`). Declaring them here rather than
 * installing listeners wherever the behavior lives is what makes the keys collide loudly across
 * plugins, print in the sidebar's help table, and stop answering when a plugin is disabled.
 *
 * Ids are built from `shellManifest.id` rather than spelled: a binding is namespaced by its
 * owner exactly as an action name is, and composition refuses a row that is not.
 */
export const SHELL_BINDINGS: readonly WebBinding[] = [
  /*
    Arrange mode: the workspace's own panes become grabbable. The mode is published view state
    (`vantage.arranging`), so the handler is the vantage store's toggle and nothing here holds
    the flag — a second copy of "is this device arranging" is the drift invariant 14 forbids.
    Escape-to-exit is deliberately NOT a row: every mode's universal "never mind" belongs to
    whatever is armed at the moment, and a table row would claim it against every dialog too.
  */
  {
    id: `${shellManifest.id}.arrange`,
    key: "F8",
    label: "Arrange mode",
    when: "always",
    run: toggleArranging,
  },
  /*
    The drop-zone probe: a debug painting of what the drop resolver answers across a tile area.
    It reads as `always` because both disciplines hold tile areas — a composition's own tree and
    a canvas widget's — and the probe simply has nothing to paint anywhere else.
  */
  {
    id: `${shellManifest.id}.zone-probe`,
    key: "F9",
    label: "Drop-zone probe",
    when: "always",
    run: toggleZoneProbe,
  },
];
