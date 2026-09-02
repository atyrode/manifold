import type { WebBinding } from "@manifold/plugin";
import { toggleZoneProbe } from "@manifold/plugin/ui";

import { debugManifest } from "./index.ts";
import { Inspector, toggleInspector } from "./inspector.tsx";
import "./styles.css";

/**
 * `core.debug`, browser half: the two keys the diagnostics answer to, and the overlay the
 * inspector paints into.
 *
 * A binding row is a DECLARATION — key, label, scope — and the handler beside it is this
 * plugin's own. Declaring them here rather than installing listeners wherever the behaviour
 * lives is what makes the keys collide loudly across plugins, print in the sidebar's key table,
 * and stop answering the moment this plugin is disabled. Ids are built from `debugManifest.id`
 * rather than spelled: a binding is namespaced by its owner exactly as an action name is, and
 * composition refuses a row that is not.
 */
export const DEBUG_BINDINGS: readonly WebBinding[] = [
  /*
    The inspector. `always`, because there is nothing it cannot be pointed at: the sidebar rail,
    the workspace frame, a routed container and everything inside one all declare themselves in
    the DOM, and the mode's answer for an undeclared point is the honest "nothing".
  */
  {
    id: `${debugManifest.id}.inspect`,
    key: "F10",
    label: "Inspect",
    when: "always",
    run: toggleInspector,
  },
  /*
    The drop-zone probe, relocated from `core.shell` unchanged. It reads as `always` because both
    disciplines hold tile areas — a composition's own tree and a canvas portal's — and the probe
    simply has nothing to paint anywhere else. The PAINTING stays in the engine's standard
    library (`TileZoneDebug`), where the tile trees that mount it live; what moved is the key
    that reaches it, which was never the shell's to own.
  */
  {
    id: `${debugManifest.id}.zone-probe`,
    key: "F9",
    label: "Drop-zone probe",
    when: "always",
    run: toggleZoneProbe,
  },
];

/**
 * What this plugin registers in the browser. The inspector fills the workspace's `inspector`
 * overlay slot — chrome with no container to hang on, since the chip must be able to name the
 * sidebar row under the pointer — and paints NOTHING while the mode is off.
 */
export const debugWebPlugin = {
  /*
    The id SPELLED, as every other web registration spells it: `packages/web/src/assembly.ts`
    is read statically by the gate (S1) to check that nothing registers chrome for a plugin the
    roster never composed, and a computed id is a name that check cannot follow back to a
    manifest. The manifest is still the authority — `index.ts` declares this same string once —
    and S5 is what keeps the two from drifting apart.
  */
  id: "core.debug",
  bindings: DEBUG_BINDINGS,
  workspaceOverlays: { inspector: Inspector },
};
