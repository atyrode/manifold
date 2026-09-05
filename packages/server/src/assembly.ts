import { accessActions, accessManifest } from "@manifold-plugin/access";
import { accessHandlers } from "@manifold-plugin/access/server";
import { arrangeManifest } from "@manifold-plugin/arrange";
import { brandManifest } from "@manifold-plugin/brand";
import { canvasManifest } from "@manifold-plugin/canvas";
import { commandsManifest } from "@manifold-plugin/commands";
import { compositionsManifest } from "@manifold-plugin/compositions";
// THROWAWAY SPIKE ROW — never merge (docs/spikes/code-launcher.md).
import { codeLauncherSpikeManifest } from "@manifold-plugin/code-launcher-spike";
import { drawElements, drawManifest } from "@manifold-plugin/draw";
import { eventsActions, eventsManifest } from "@manifold-plugin/events";
import { eventsHandlers } from "@manifold-plugin/events/server";
import { keysActions, keysManifest } from "@manifold-plugin/keys";
import { keysHandlers } from "@manifold-plugin/keys/server";
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
import { debugManifest } from "@manifold-plugin/debug";
import { indexActions, indexManifest } from "@manifold-plugin/index";
import { indexHandlers } from "@manifold-plugin/index/server";
import type { FloorEventOwners } from "./event-hub.ts";
import type { ServerPluginDef } from "./plugin-host.ts";

/**
 * WHICH plugin declares the vocabulary for each concept the FLOOR emits about (ADR 0012 §1:
 * the engine emits at the doors it owns, the plugin declares the kinds).
 *
 * It lives here because this is the only server file allowed to name a plugin at all: the
 * terminal broker owns a PTY's whole lifecycle, the room owns its attendance
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
  /*
    THE RAIL'S NON-NEGOTIABLES (issue #91). `core.brand` is browser-only — a mark is not
    authority — and registered here all the same, because the ROSTER is what publishes a
    plugin's existence, its title and its `essential` flag to every reader and administrator.

    `core.keys` owns both halves: the seat that lists every key the composition composed, and
    the two doors that write this principal's rebindings over it. The key REGISTRY itself is
    browser-side registration data the server has never seen, which is exactly why these
    handlers refuse only what a stored override map can prove (`keysHandlers`).
  */
  { manifest: brandManifest, actions: [], handlers: {} },
  { manifest: keysManifest, actions: keysActions, handlers: keysHandlers },
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
  /*
    The diagnostic seat: browser-only, door-less, and registered here for the reason every
    browser-only plugin is — the roster is what makes it nameable in the key table and
    toggleable in the manager. Turning it off is how an operator takes the probes away.
  */
  { manifest: debugManifest, actions: [], handlers: {} },
  /*
    The F8 scene editor: browser-only, door-less — every write it makes is `core.space`'s own
    `setLayout` — and registered here for the reason every browser-only plugin is: the roster
    is what makes it nameable, toggleable, and its F8 row visible in the key table.
  */
  { manifest: arrangeManifest, actions: [], handlers: {} },
  /*
    The command surface (issue #129): browser-only and door-less by construction — it OPENS
    other plugins' doors and declares none of its own — and registered here for the reason
    every browser-only plugin is. It matters more than usual for this one: the roster is what
    publishes the actions it lists, so a seat that reads the composition has to be IN the
    composition to be turned off with everything else.
  */
  { manifest: commandsManifest, actions: [], handlers: {} },
  // The two container renderers are browser-only for the same reason: what they draw is a
  // projection, and every write they make is somebody else's declared door.
  { manifest: canvasManifest, actions: [], handlers: {} },
  { manifest: compositionsManifest, actions: [], handlers: {} },
  // THROWAWAY SPIKE ROW — never merge (docs/spikes/code-launcher.md). Browser-only, door-less.
  { manifest: codeLauncherSpikeManifest, actions: [], handlers: {} },
];

/**
 * THE SHIPPED DISTRIBUTION, as a set of ids — derived from the table above by reading it, not
 * by restating it. This is what defends the `core.` namespace: `assembleRoster` refuses a
 * manifest under `core.` that is not in here (`AssemblyEnv.distribution`,
 * `CORE_NAMESPACE_PREFIX`), so a third-party plugin named `core.anything` fails composition by
 * name instead of publishing a row that reads as official on every roster.
 *
 * DERIVED IS THE WHOLE DESIGN. A hand-kept list of "our" plugins would be a second statement
 * of the same fact and would go stale the first time somebody adds a row twenty lines up
 * (invariant 14) — and a stale one fails in the worst direction, refusing a plugin the
 * distribution genuinely ships. Adding a row above is therefore the entire diff, exactly as
 * "builtin" is derived from what the ENGINE registers rather than claimed by a manifest.
 *
 * The web half needs no second set: `packages/web/src/assembly.ts` only ATTACHES components to
 * ids this table already published, and `verify:axioms` S1 refuses a web registration whose id
 * nothing composed — so every `core.` id the browser knows is one of these by construction.
 */
export const SHIPPED_PLUGIN_IDS: ReadonlySet<string> = new Set(
  SERVER_PLUGIN_DEFS.map((def) => def.manifest.id),
);
