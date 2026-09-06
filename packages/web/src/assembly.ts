import { SessionsSection } from "@manifold-plugin/access/web";
import { ArrangeOverlay, ARRANGE_BINDINGS } from "@manifold-plugin/arrange/web";
import { BrandRow } from "@manifold-plugin/brand/web";
import { canvasWebPlugin } from "@manifold-plugin/canvas/web";
import { CommandsOverlay, COMMANDS_BINDINGS } from "@manifold-plugin/commands/web";
import { compositionsWebPlugin } from "@manifold-plugin/compositions/web";
import { debugWebPlugin } from "@manifold-plugin/debug/web";
import { drawWebPlugin } from "@manifold-plugin/canvas/draw/web";
import { KeysRow } from "@manifold-plugin/keys/web";
import { MachinesSection } from "@manifold-plugin/machines/web";
import { notesWebPlugin } from "@manifold-plugin/notes/web";
import { PluginManagerSection } from "@manifold-plugin/plugin-manager/web";
import { presenceWebPlugin } from "@manifold-plugin/presence/web";
import { terminalsWebPlugin } from "@manifold-plugin/terminals/web";
import { uriWebPlugin } from "@manifold-plugin/uri/web";
import { IndexSection, NewFolderRow } from "@manifold-plugin/index/web";
import { accessManifest } from "@manifold-plugin/access";
import { indexManifest } from "@manifold-plugin/index";
import { machinesManifest } from "@manifold-plugin/machines";
import { presenceManifest } from "@manifold-plugin/presence";
import { shellManifest, spaceManifest } from "@manifold-plugin/shell";
import {
  ContainerViewPanel,
  IdentityRow,
  SidebarPanel,
  StatusRow,
} from "@manifold-plugin/shell/web";
import { terminalsManifest } from "@manifold-plugin/terminals";
import { panelRefId, type FeedTopics } from "@manifold/plugin";
import type { WebPluginDef } from "./plugin-host.tsx";

/**
 * WHICH panel a reader's SECTION ARRANGEMENT is committed to — the one datum `workspace.tsx`
 * may not spell for itself.
 *
 * It lives here because this is the only file in `packages/web/src` allowed to name a plugin,
 * and a panel id IS a plugin's name: `core.shell.sidebar` is `core.shell`'s, spelled in the
 * same `<pluginId>.<panelId>` join the assembly claims panels under (`panelRefId`, so the
 * rule has one implementation). `workspace.tsx` reads it from here and is a sibling floor file
 * consuming exported data, which is the sanctioned direction; `workspace.tsx` spelling the id
 * itself would make the shell's arrangement path name a favorite plugin, which is the
 * neutrality criterion of AXIOMS.md §Foundation law.
 *
 * What is NO LONGER here is the panel PAIR a default workspace tree used to be built from.
 * The default is composed from the enabled roster's own declared seats
 * (`composeDefaultLayout`), so the arrangement and the names come from one place — the
 * manifests — and no `assembly.ts` keeps a favourite pair for the boot fallback.
 */
export const SIDEBAR_PANEL = panelRefId(shellManifest.id, "sidebar");

/**
 * WHICH DOORS THE FLOOR ITSELF KNOCKS ON — the five action names `packages/web/src` dispatches
 * for its own account, spelled here for the reason `SIDEBAR_PANEL` is: an action name is the
 * pair `${manifest.id}.${local}`, so writing one is naming a plugin, and this is the only file
 * in `packages/web/src` allowed to do that. Each is built from the manifest rather than typed
 * out, the convention `core.keys` set and `core.access` follows for its own chrome, so the
 * shell's boot path cannot drift from the declaration it calls.
 *
 * The three seats behind them are `essential` (issue #113), and that is what makes the floor's
 * reliance sound rather than merely tidy. `core.space` writes the workspace tree — including
 * the placeholder's pruned commit, which is how a disabled panel plugin can never brick a
 * layout. `core.index` mints and reads the containers a route resolves. `core.access` turns
 * the owner key into an identity, which is the first thing that happens in this app and the
 * only path to it. A floor that dispatches a door may not have that door taken away
 * underneath it: an ordinary seat named here would be a shell that stops working when an
 * administrator flips a switch the roster says is theirs to flip.
 *
 * Every OTHER plugin the floor names is named as DATA it may find absent — `FEED_TOPICS`
 * below subscribes to `core.terminals`, `core.presence` and `core.machines`, all ordinary and
 * all disableable, because a subscription to a node whose plugin is off simply reports
 * nothing. Naming a door is the coupling that needs the guarantee; naming a topic is not.
 */
export const SPACE_SET_LAYOUT_ACTION = `${spaceManifest.id}.setLayout`;
export const INDEX_CREATE_CONTAINER_ACTION = `${indexManifest.id}.createContainer`;
export const INDEX_CREATE_FOLDER_ACTION = `${indexManifest.id}.createFolder`;
export const INDEX_READ_CONTAINER_ACTION = `${indexManifest.id}.readContainer`;
export const ACCESS_CREATE_PRINCIPAL_ACTION = `${accessManifest.id}.createPrincipal`;

/**
 * WHICH NODES each shared feed subscribes to (ADR 0012). Every entry is a COLLECTION — a
 * plugin's own node — and each member lists every node that MOVES that reading, not only
 * its owner's. Two of them move readings that are not their own, and both are here because
 * the reading would otherwise go stale in a way no cadence is left to cover:
 *
 *   `core.space` — a placement commit births solo compositions, absorbs the emptied ones,
 *     and re-flags terminals, because `unplaced` is DERIVED from the containment graph. So
 *     the index and both terminal readings watch the spatial door's node beside their owners'.
 *   `core.terminals` — a terminal is BORN with a home composition and takes it away when it
 *     is killed (`createHome`, `dropContainer`), so a terminal's lifecycle adds and removes
 *     rows at the index's own top level.
 *
 * One subscription per node, rather than one per container, because all four answers are
 * workspace-wide readings taken from chrome outside every room they report on — which is also
 * why a node-addressed event never reaches them and the server delivers every emission to its
 * door's collection as well (`EventHub.fanOut`).
 *
 * It lives here for the same reason `SIDEBAR_PANEL` does, and it is the browser's exact
 * counterpart of the server's `FLOOR_EVENT_OWNERS`: a topic is `manifold://plugin/<owner>`,
 * so writing one is naming a plugin, and this is the only file in `packages/web/src` allowed
 * to (`verify:axioms` S2). The floor shell reads it from here as a sibling floor file; the
 * sections read it off `host.topics`, since a plugin may not name another plugin either.
 * Swapping in a stranger's terminals plugin is one line, here.
 */
export const FEED_TOPICS: FeedTopics = {
  index: [
    { kind: "plugin", pluginId: indexManifest.id },
    { kind: "plugin", pluginId: spaceManifest.id },
    { kind: "plugin", pluginId: terminalsManifest.id },
  ],
  terminals: [
    { kind: "plugin", pluginId: terminalsManifest.id },
    { kind: "plugin", pluginId: spaceManifest.id },
  ],
  attendance: [{ kind: "plugin", pluginId: presenceManifest.id }],
  machines: [{ kind: "plugin", pluginId: machinesManifest.id }],
};

/**
 * THE registration file, and the ONE file in `packages/web/src` allowed to name
 * `@manifold-plugin/*` (REGISTRY.md §Foundation; `verify:axioms` S2 asserts the exception is
 * exactly this file). Everything below it is engine floor that must not know a plugin exists;
 * everything above it is a plugin that must not know the engine's internals.
 *
 * A registration only ATTACHES components to names the SERVER's roster already published: the
 * roster is the vocabulary (which plugins exist, whether each is enabled, what each declares),
 * and this list is the browser's answer to "who draws it". Attaching a panel nobody declared
 * contributes nothing; a declared panel with no attachment renders a named placeholder.
 *
 * THE LIST IS NOW THE WHOLE STORY, and that is the conversion finishing rather than a tidy-up.
 * Until this wave two plugins registered nothing here while owning piles of browser code,
 * because the canvas and composition renderers were floor and simply IMPORTED them. Both renderers
 * are plugins now, plugins may not import each other, and so every one of those reaches
 * matches a row below:
 *
 *   `core.canvas` / `core.compositions` register CONTAINER REFS, keyed by container discipline,
 *     and one SECTION each — their own creator in the rail. Neither declares a panel: a
 *     renderer is reached by layout, and the routed shell and a tile leaf embedding a canvas
 *     ask for it identically.
 *   `core.terminals` registers the TERMINAL FACET — the viewer plus the machine-choice policy
 *     a ref needs in order to offer "new terminal" — instead of exporting a component two
 *     renderers imported.
 *   `core.presence` registers OVERLAYS: who is here, and the spotlight consent chip. What a
 *     ref paints in its own coordinate space (cursors, carry ghosts, selection outlines)
 *     it paints from engine plane mechanism, which is invariant 11 rather than a registration.
 *
 * `core.shell` REGISTERS ITS OWN TWO PANELS NOW, and that row is the last carve-out closing.
 * Both components were floor until this wave, on the argument that the sidebar's chrome has to
 * read the live composition to know which sections exist and no plugin had a door for that read.
 * `host.assembly` is that door — declared, read-only, neutral — so the exception expired and
 * both components moved into `@manifold-plugin/shell`, beside the manifest that declared their
 * ids and beside the KEYS the package already owned (`SHELL_BINDINGS`). What stayed floor is
 * what a shell genuinely owns: the tile layout, the workspace index, and the two contexts it
 * publishes above the tree for its panels to read.
 *
 * AND IT REGISTERS ITS OWN FOUR ROWS, which is the same sentence one level down. The rail's
 * brand line, status line, key-table door and identity footer were hand-written inside that
 * panel until this wave — chrome nobody could read off the assembly, nothing could order, and
 * arrange mode could not move. They are contributions now, and so are the three creators
 * (`core.canvas`, `core.compositions`, `core.index`) that used to be a hard-coded strip above
 * the stack. The panel imports none of them: it reads the composed section list and asks the
 * projection registry who draws each id, which is what makes the shell's own rows arrive by
 * exactly the route a stranger's do.
 *
 * `core.` IS RESERVED, and this file is one of the two halves of that reservation. The shipped
 * distribution's ids are derived from `packages/server/src/assembly.ts` (`SHIPPED_PLUGIN_IDS`)
 * and handed to `assembleRoster`, which refuses any manifest under `core.` that is not in the
 * set — so a stranger's plugin cannot publish an official-looking row. This file keeps no
 * second copy of that set, deliberately: a registration here only attaches components to an id
 * the server's roster already published, so every `core.` id below is one the server table
 * shipped, and `verify:axioms` S1 fails a registration whose id nothing composed rather than
 * letting the two files disagree. Registering a web half for `core.something` the server never
 * registered is therefore a gate failure, not a silently inert row.
 */
export const WEB_PLUGIN_DEFS: readonly WebPluginDef[] = [
  {
    id: "core.shell",
    panels: { sidebar: SidebarPanel, "container-view": ContainerViewPanel },
    /*
      The rail chrome the shell still owns, attached exactly like anybody else's row. The
      sidebar panel does not import these two: it reads `host.assembly.sections` and asks the
      projection registry for whoever registered each id, so `core.shell` reaches its own
      sidebar by the same route a stranger's plugin does — which is the only way "the rail is
      composed" can be checked rather than asserted.
    */
    sections: { status: StatusRow, identity: IdentityRow },
    /*
      No `bindings` row: the shell claims no keys at all now. Arrange mode's F8 went to
      `core.arrange` and the drop-zone probe's F9 to `core.debug`, each beside the behaviour it
      reaches — so the key table's owner column names the plugin that implements the key.
    */
  },
  { id: "core.index", sections: { index: IndexSection, "new-folder": NewFolderRow } },
  { id: "core.machines", sections: { machines: MachinesSection } },
  /*
    The credential list (ADR 0019 §3) — `core.access`'s first UI after two waves of
    door-only, attached exactly like any other row. It draws principals and their live
    credentials; the fleet's half of the same question stays in `core.machines` above,
    because the concept is that plugin's.
  */
  { id: "core.access", sections: { sessions: SessionsSection } },
  { id: "core.plugins", sections: { plugins: PluginManagerSection } },
  /*
    THE RAIL'S NON-NEGOTIABLES, as seats of their own (issue #91). The brand line and the key
    table were `core.shell` rows and the plugin ledger was an ordinary body in the middle of the
    stack; all three are `essential: true` now, because a rail with no name on it, no way to
    read its keys, or no ledger of what is on is not a degraded workspace but a broken one. Each
    is an ordinary row here — an essential seat gets no privileged registration, only a refusal
    at the engine's enablement door.
  */
  { id: "core.brand", sections: { brand: BrandRow } },
  { id: "core.keys", sections: { keys: KeysRow } },
  /*
    The F8 scene editor (issue #89): its own key row, and its one workspace overlay — the
    floating toolbar, the panel grips and their live preview, and the wireframe delimitation,
    all painted through the SAME slot channel a container overlay uses one host up.
  */
  {
    id: "core.arrange",
    bindings: ARRANGE_BINDINGS,
    workspaceOverlays: { toolbar: ArrangeOverlay },
  },
  /*
    The command surface (issue #129), registered in exactly the arrange shape above it and for
    the same two reasons: its one key is an ordinary row in the composed table, and what it
    paints is chrome over the WORKSPACE rather than a seat in anybody's tree — reachable at the
    workspace root, where no container and therefore no container slot exists.
  */
  {
    id: "core.commands",
    bindings: COMMANDS_BINDINGS,
    workspaceOverlays: { commands: CommandsOverlay },
  },
  canvasWebPlugin,
  compositionsWebPlugin,
  drawWebPlugin,
  notesWebPlugin,
  presenceWebPlugin,
  terminalsWebPlugin,
  uriWebPlugin,
  debugWebPlugin,
];
