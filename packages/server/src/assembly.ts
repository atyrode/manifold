import { accessActions, accessManifest } from "@manifold-plugin/access";
import { accessHandlers } from "@manifold-plugin/access/server";
import { canvasManifest } from "@manifold-plugin/canvas";
import { compositionsManifest } from "@manifold-plugin/compositions";
import { drawElements, drawManifest } from "@manifold-plugin/draw";
import { eventsActions, eventsManifest } from "@manifold-plugin/events";
import { eventsHandlers } from "@manifold-plugin/events/server";
import { machinesActions, machinesManifest } from "@manifold-plugin/machines";
import { machinesHandlers } from "@manifold-plugin/machines/server";
import { notesElements, notesManifest } from "@manifold-plugin/notes";
import { pluginManagerManifest } from "@manifold-plugin/plugin-manager";
import { presenceActions, presenceManifest } from "@manifold-plugin/presence";
import { presenceHandlers } from "@manifold-plugin/presence/server";
import { spaceActions, spaceManifest, shellManifest } from "@manifold-plugin/shell";
import { spaceHandlers } from "@manifold-plugin/shell/server";
import { terminalsActions, terminalsManifest } from "@manifold-plugin/terminals";
import { terminalsHandlers } from "@manifold-plugin/terminals/server";
import { uriManifest } from "@manifold-plugin/uri";
import { indexActions, indexManifest } from "@manifold-plugin/index";
import { indexHandlers } from "@manifold-plugin/index/server";
import { panelRefId, type WorkspacePanels } from "@manifold/plugin";
import type { FloorEventOwners } from "./event-hub.ts";
import type { ServerPluginDef } from "./plugin-host.ts";

/**
 * WHICH panels a default workspace tree is built from — the one datum the floor's
 * `workspaceLayout()` cannot know and must be handed.
 *
 * It lives here because this is the only server file allowed to name a plugin at all, and a
 * panel id IS a plugin's name: `core.shell.sidebar` is `core.shell`'s, spelled in the same
 * `<pluginId>.<panelId>` join the assembly claims panels under (`panelRefId`, so the rule has
 * one implementation). Putting this in `layout.ts`, or in `http.ts` where the fallback is
 * served, would make a floor file name a favorite plugin — the neutrality criterion of
 * AXIOMS.md §Foundation law, failing in the one file that must be replaceable wholesale.
 * `main.ts` reads it from here and injects the built tree into the HTTP app; the browser half
 * has its own copy in `packages/web/src/assembly.ts` for the same reason, and `verify:axioms`
 * (S1) asserts both resolve against their own assembly.
 */
export const WORKSPACE_PANELS: WorkspacePanels = {
  sidebar: panelRefId(shellManifest.id, "sidebar"),
  main: panelRefId(shellManifest.id, "container-view"),
};

/**
 * WHICH plugin declares the vocabulary for each concept the FLOOR emits about (ADR 0012 §1:
 * the engine emits at the doors it owns, the plugin declares the kinds).
 *
 * It lives here for exactly the reason `WORKSPACE_PANELS` above does, and it is the same shape
 * of datum: the terminal broker owns a PTY's whole lifecycle, the room owns its attendance
 * roster, and the machine registry owns liveness — but none of the three may name a plugin,
 * because a floor file naming a favorite plugin is the neutrality criterion of
 * `AXIOMS.md` §Foundation law failing in the one layer that must be replaceable wholesale.
 * So each of them emits by CONCEPT (`"terminals"`, `"attendance"`, `"machines"`, `"shares"`)
 * and this table is where the concept meets a name. Swap `core.terminals` for a stranger's
 * terminals plugin and this line is the whole diff.
 *
 * Each id must DECLARE the kinds its concept's door emits, or the hub refuses the emission by
 * name — which is the D5 collision refusal's other half: a vocabulary nobody claimed is as
 * refusable as one two plugins claimed.
 */
export const FLOOR_EVENT_OWNERS: FloorEventOwners = {
  terminals: terminalsManifest.id,
  attendance: presenceManifest.id,
  machines: machinesManifest.id,
  /*
    `core.access` owns the cross-instance words because it owns the doors that create and
    destroy the relationship — mintShare, revokeShare, dialShare, openDial. The dialer
    announces a socket coming up or going down, which no action commits, but the vocabulary
    for what a share IS belongs to the plugin a principal administers shares through.
  */
  shares: accessManifest.id,
};

/**
 * THE registration point, and the only server file allowed to import `@manifold-plugin/*`
 * (REGISTRY.md floor registry, enforced by `verify:axioms`). Everything above the floor
 * arrives here or does not exist.
 *
 * This table is the input to the ASSEMBLY: the join the host computes over the enabled
 * roster, turning a list of plugin definitions into one vocabulary of actions, panels,
 * elements and sections. Nothing named here is in the assembly by virtue of being listed —
 * it is a candidate the roster admits or an administrator disables.
 *
 * This is also where the sandbox shape is CHECKED. Each plugin's handlers are typed against
 * minimal structural slices declared inside the plugin — `{ broker: { rename(...) } }`,
 * `{ rooms: { sharedContainerIds(...) } }` — and assigning them into `ServerPluginDef` here
 * is what proves those slices are satisfied by the real `ActionCtx`. A plugin that widens
 * its demands fails this assignment rather than quietly reaching further into the server.
 */
export const SERVER_PLUGIN_DEFS: readonly ServerPluginDef[] = [
  // The shell contributes the two panels every workspace layout is built from and declares
  // no actions: chrome is not authority.
  { manifest: shellManifest, actions: [], handlers: {} },
  { manifest: spaceManifest, actions: spaceActions, handlers: spaceHandlers },
  // The plugin manager is a UI over the assembly and owns no door: enablement and purge
  // are the ENGINE's builtin row (`engine.plugins`), registered by the host itself rather
  // than here, because administration of the assembly cannot be a member of it.
  { manifest: pluginManagerManifest, actions: [], handlers: {} },
  { manifest: terminalsManifest, actions: terminalsActions, handlers: terminalsHandlers },
  { manifest: presenceManifest, actions: presenceActions, handlers: presenceHandlers },
  { manifest: accessManifest, actions: accessActions, handlers: accessHandlers },
  /*
    A DOOR-ONLY row: `core.events` publishes one read over the audit trail and contributes no
    panel, section, element or tool, exactly like `core.access` above it. That is not an
    incomplete registration — a row is what makes a capability EXIST for a reader, an
    administrator and an agent alike, and the interface over this trail is a screen somebody
    still has to design. Registering the door first is what lets that screen be a plugin
    instead of another conversion.
  */
  { manifest: eventsManifest, actions: eventsActions, handlers: eventsHandlers },
  // The index owns both halves: the sidebar section that lists everything, and the doors
  // that create, rename, delete and move it.
  { manifest: indexManifest, actions: indexActions, handlers: indexHandlers },
  // The fleet owns both halves too: the section that lists it, and the doors that read the
  // inventory and enroll into it.
  { manifest: machinesManifest, actions: machinesActions, handlers: machinesHandlers },
  /*
    Browser-only plugins, registered here all the same: the ROSTER is what publishes a
    plugin's existence, its title and its contributions, and what an administrator toggles.
    A plugin the server never heard of cannot be named in a placeholder, cannot be disabled,
    and its element type would read as "unknown plugin" on every canvas.
  */
  /*
    `elements` carries these two plugins' PER-TYPE PAYLOAD SCHEMAS (ADR 0013 §16). The protocol's
    element schema is a neutral envelope — it holds the geometry and bounds the payload, and names
    no element type — so what a `draw` or a `text` record must actually contain is declared by
    whoever declared the type, and this row is where that declaration reaches the assembly. It
    sits on the DEFINITION rather than in the manifest for the same reason handlers do: a schema
    is code, and manifests stay inert data (ADR 0010 rule 2).
  */
  { manifest: drawManifest, actions: [], handlers: {}, elements: drawElements },
  { manifest: notesManifest, actions: [], handlers: {}, elements: notesElements },
  { manifest: uriManifest, actions: [], handlers: {} },
  // The two container renderers are browser-only for the same reason: what they draw is a
  // projection, and every write they make is somebody else's declared door.
  { manifest: canvasManifest, actions: [], handlers: {} },
  { manifest: compositionsManifest, actions: [], handlers: {} },
];
