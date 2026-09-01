import type {
  ActionOutcome,
  Cap,
  MachineSummary,
  Container,
  Attendance,
  ContainerTerminalSummary,
  IndexEntry,
  ManifoldRef,
  PlaceResponse,
  PlacementDenial,
  PlacementDestination,
  PlacementRef,
  Principal,
  PluginRoster,
  ServerEvent,
  TerminalSummary,
} from "@manifold/protocol";
import type { ScenePatch, Y } from "@manifold/scene";
import type { AssemblySection } from "./assemble.ts";
import type { ComposedBinding } from "./bindings.ts";

/**
 * What `place()` answers: the placement it executed, or the declared RULE that refused it.
 * Structurally identical to the SDK's own `PlaceOutcome` — the engine cannot depend on the
 * SDK (the SDK is a consumer of these contracts, not a provider of them), so the shape is
 * restated here over the same protocol types and satisfied structurally.
 */
export type PlaceOutcome =
  | { readonly ok: true; readonly result: PlaceResponse }
  | { readonly ok: false; readonly denial: PlacementDenial };

/**
 * How live the session channel is, restated over the SDK's own five states for the same
 * reason every other member of {@link SessionHandle} is restated: the engine may not import
 * the SDK. It exists on this ref because the EVENT plane has a liveness question the other
 * doors do not — a subscription only delivers while a socket is up, so a consumer that traded
 * its timer for one has to know when the trade is off (ADR 0012 §5: catch-up is reading state).
 */
export type SessionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * The terminal ref a plugin is handed. It is deliberately the SDK's own ref described
 * structurally: `SessionClient` satisfies it without importing anything from here, so a
 * plugin talks to the server through exactly the doors a stranger's agent has, and nothing
 * else. Whatever is not on this interface is not reachable from plugin code — that is the
 * sandbox shape (ADR 0010) the contracts keep even while plugins run in-process.
 */
export interface SessionHandle {
  /** Invoke an action by its FULL name (`core.terminals.rename`); a denial is data, not a throw. */
  action(name: string, args: unknown): Promise<ActionOutcome>;
  /** THE placement call: put an item in a container. */
  place(ref: PlacementRef, destination: PlacementDestination): Promise<PlaceOutcome>;
  /** The caller's own caps, as the server granted them: what UI to offer, and what to gray out. */
  selfCaps(): readonly Cap[];
  machines(): Promise<readonly MachineSummary[]>;
  index(): Promise<readonly IndexEntry[]>;
  attendanceByContainer(): Promise<readonly Attendance[]>;
  terminalsByContainer(): Promise<readonly ContainerTerminalSummary[]>;
  allTerminals(): Promise<readonly TerminalSummary[]>;
  /*
    The workspace index's own writes. They are HTTP routes rather than actions this wave
    (REGISTRY.md §Full-conversion inventory: "container/folder CRUD + tree moves →
    workspace-index actions"), so the
    plugin that renders the index reaches them through the same handle it reads with — one
    door per concept, and the section that lists containers is also the one that renames
    them. When those routes become actions these methods go away and `action()` carries
    them; nothing else about the section changes.
   */
  renameContainer(containerId: string, name: string): Promise<Container>;
  deleteContainer(containerId: string): Promise<void>;
  createFolder(name: string, parentId: string | null): Promise<readonly IndexEntry[]>;
  renameFolder(folderId: string, name: string): Promise<readonly IndexEntry[]>;
  deleteFolder(folderId: string): Promise<readonly IndexEntry[]>;
  moveIndexEntry(
    item: { readonly kind: "container" | "folder"; readonly id: string },
    parentId: string | null,
    index: number,
  ): Promise<readonly IndexEntry[]>;
  /** One container's record, for a reference the index has not answered yet. */
  getContainer(containerId: string): Promise<Container>;
  /**
   * Removes one leaf from an assembly. Removal is the one tile gesture that is NOT a
   * placement — nothing accepts "nowhere" for a LEAF — so it is its own verb here, while
   * every MOVE of a leaf's occupant goes through `place`.
   */
  removeContainerTile(containerId: string, tileId: string): Promise<void>;
  /**
   * THE event-plane door (ADR 0012). Declares interest in a set of NODES and answers the
   * release; the handler is a notification, never a payload to apply — a consumer that needs
   * the new state reads it through the door above, which is what makes the plane free of
   * queue semantics. Subscribing before the socket is open is legal: the declaration goes out
   * with the join, and it is re-declared after a reconnect.
   */
  subscribe(topics: readonly ManifoldRef[], handler: (event: ServerEvent) => void): () => void;
  /** Whether the channel that carries subscriptions is up right now. */
  readonly status: SessionStatus;
  /** Transitions of {@link SessionHandle.status}; returns the release. */
  on(event: "status", fn: (status: SessionStatus) => void): () => void;
}

/**
 * The viewport of the container currently on screen, when one is. Plugins never reach into the
 * renderer: they ask the host to move the view (a spotlight lands here) and to report where
 * it is. Null when no container view is mounted — the workspace root, for instance.
 */
export interface ViewportHandle {
  centerOn(uri: string): void;
  viewport(): { x: number; y: number; zoom: number } | null;
}

/**
 * The last spotlight this client APPLIED, as a `manifold://` URI. One mutable slot, because
 * "what did the viewport actually do" has exactly one answer per device.
 *
 * It lives in the engine because its writer and its reader are on opposite sides of the
 * plugin boundary and must not import each other: `core.presence` applies a spotlight and
 * records it here, and the web floor's debug probe (`ManifoldDebugProbe.lastSpotlight`, read by
 * the axioms gate) reads it here. Recording where the camera MOVES rather than where the
 * frame ARRIVES is the point — a spotlight the viewer has switched off never lands.
 */
let appliedSpotlight: string | null = null;

export function recordSpotlight(uri: string): void {
  appliedSpotlight = uri;
}

export function lastSpotlight(): string | null {
  return appliedSpotlight;
}

/**
 * The mounted container view's authoring door. A terminal is born INSIDE a container, and only
 * the renderer on screen knows how its discipline authors one (a canvas writes an element,
 * a composition lets the server place a tile) — so a plugin asks for the birth instead of
 * performing it. Null when no view is mounted, or when the mounted view cannot author:
 * exactly the case where the affordance must not be offered.
 */
export interface AuthoringHandle {
  createTerminal(machine?: MachineSummary): void;
}

/**
 * ONE COMPOSED SIDEBAR ROW, as any plugin may read it: {@link AssemblySection} — the manifest
 * facts the composition already resolved, `presentation` included — plus the one roster fact a
 * reader needs beside them.
 *
 * It EXTENDS the compose-time row rather than restating it, because there is exactly one
 * section registry and this is its published view (invariant 14). A reader hunting for a
 * second list of sections will not find one: `plain` and `disclosure` rows inhabit this array
 * together, in the one declared order, and only the component filling a row reads
 * `presentation`.
 */
export interface ComposedSection extends AssemblySection {
  /** False for a DISABLED owner and for an id the roster does not carry. */
  readonly enabled: boolean;
}

/**
 * The assembly, as DATA — the one read surface onto the live composition, for every plugin
 * alike. A plugin that administers plugins needs to read the roster it is listing; the
 * workspace shell needs the rows and the keys the composition composed in order to draw a
 * sidebar it does not own the contents of. Both are the same question — "what did the
 * composition decide" — so both are answered here, and neither gets a lever: no registration,
 * no override, no assembling. Mutating the assembly is an action
 * (`engine.plugins.setEnabled`, the engine's own builtin door), like every other
 * authority-bearing change.
 *
 * It is NEUTRAL by construction: every member is keyed by an id the caller already holds, and
 * nothing here names a favourite plugin (AXIOMS.md §Foundation law). A stranger's replacement
 * for the workspace shell reads exactly what `core.shell` reads.
 *
 * What is deliberately ABSENT is a component. `presentation` says how a row draws; WHO draws
 * it is a registration, reached through the projection registry's `SectionOutlet` like every
 * other contributed component — which is also why this file stays React-free, since the
 * SERVER composes through the same `@manifold/plugin` entry.
 */
export interface AssemblyFacet {
  roster(): PluginRoster;
  enabled(id: string): boolean;
  /** The plugin's human title, for placeholders, key tables and admin chrome; null when unknown. */
  pluginTitle(id: string): string | null;
  /**
   * Every DECLARED section, sorted by declared `order` with ties in roster order — a disabled
   * owner's row is present and marked, never dropped, because chrome renders absence (D4′,
   * ADR 0013) and a stored arrangement must not forget a seat while its plugin is off.
   */
  readonly sections: readonly ComposedSection[];
  /**
   * The composed key table, sorted by key. A disabled plugin's rows are ABSENT rather than
   * marked — the one registry here that drops instead of marking, because a keystroke has no
   * surface to paint an absence on (`composeBindings`).
   */
  readonly bindings: readonly ComposedBinding[];
}

/**
 * WHICH NODE each workspace-wide feed is addressed by (ADR 0012). The four collections the
 * sidebar reads — the index, the terminal listing, the attendance roster, the machine
 * fleet — are news about a COLLECTION, not about any room, so each is one subscription on
 * the owning plugin's node rather than one per container.
 *
 * The members are CONCEPTS, exactly like the server's `FloorEventOwners`, and for the same
 * reason: a topic is `manifold://plugin/<owner>`, so spelling one is naming a plugin, and
 * the only file in `packages/web/src` allowed to do that is its `assembly.ts` (AXIOMS.md
 * §Foundation, neutrality criterion; `verify:axioms` S2). The floor shell and the sections
 * both read the answer from here, so swapping a stranger's terminals plugin in is one line
 * in one file and no consumer notices.
 */
export interface FeedTopics {
  /**
   * Each member is every node that MOVES that concept's reading — not only its owner's:
   * the index and terminal readings change when a PLACEMENT commits (a compose births a
   * container, an unplace re-flags a terminal), so those lists carry the spatial door's
   * node beside the owner's. A feed subscribes to the whole list.
   */
  readonly index: readonly ManifoldRef[];
  readonly terminals: readonly ManifoldRef[];
  readonly attendance: readonly ManifoldRef[];
  readonly machines: readonly ManifoldRef[];
}

/**
 * Everything a plugin may touch outside itself, all of it addressed: talk to the server
 * (`client`), send the viewer somewhere by `manifold://` URI (`navigate`), move the mounted
 * container's viewport (`viewport`), author into it (`authoring`), and read the assembly
 * (`assembly`). No host internals, no React context of the shell, no DOM handles — a
 * contribution that needs more needs a new declared contract.
 */
export interface HostServices {
  readonly client: SessionHandle;
  /**
   * Who this device is. A renderer paints its own ink, its own notes and its own cursor in
   * this principal's colour, and a section marks its own rows — so identity is a declared
   * member of the host ref rather than something every contribution re-fetches.
   */
  readonly principal: Principal;
  /**
   * This device's bearer. A container renderer opens its OWN room pipe — resolve the
   * reference, open a pipe with a grant, project it (A4) — and the token is the grant it
   * opens with. Plugins are trusted in-process code (ADR 0010 D1), so handing them the same
   * bearer the engine dials with is a contract rather than a leak; what it may do with it is
   * decided at the doors, per request, exactly as for any other principal.
   */
  readonly token: string;
  /**
   * The container the viewer is looking at, or null at the workspace root. Read-only and
   * declared rather than inferred: an index that cannot mark its own active row would have
   * to guess from the URL, and A2 makes "where a principal is" observable state, not a
   * private fact of one renderer. Change it by calling `navigate`.
   */
  readonly containerId: string | null;
  navigate(uri: string): void;
  readonly viewport: ViewportHandle | null;
  readonly authoring: AuthoringHandle | null;
  readonly assembly: AssemblyFacet;
  /**
   * The nodes the shared feeds subscribe to. Handed down rather than spelled here: see
   * {@link FeedTopics}.
   */
  readonly topics: FeedTopics;
}

/** A contributed panel: a tile-ref leaf, including the workspace shell's own two. */
export interface PanelProps {
  readonly host: HostServices;
}

/** A contributed sidebar section, ordered by its manifest's declared `order`. */
export interface SectionProps {
  readonly host: HostServices;
}

/**
 * THE DOCUMENT PLANE, as a contributed element sees it (D6).
 *
 * An element whose edits are document traffic — a note's prose, a stroke's points — needs the
 * room's Yjs handles and nothing else: no socket, no room membership, no knowledge of how the
 * document is synchronised. Like {@link SessionHandle} this is the SDK's own ref restated
 * structurally, so `SessionClient` satisfies it without knowing this file exists, and what is
 * absent from it is unreachable from plugin code.
 *
 * It is deliberately NOT part of {@link HostServices}: a panel or a section is chrome that
 * talks to the server, while an element renderer edits the one document it is painted in, and
 * conflating the two would hand every sidebar section a write door onto the scene.
 */
export interface ElementTx {
  patch(elementId: string, patch: ScenePatch): boolean;
  remove(elementId: string): boolean;
  text(elementId: string): Y.Text | null;
}

export interface ElementDocument {
  elementText(elementId: string): Y.Text | null;
  transact(fn: (tx: ElementTx) => void): void;
}

/**
 * The mount site, as the element renderer sees it. A contributed element is painted in two
 * disciplines — a canvas node and a tile leaf — and everything they disagree about is here, so
 * one renderer serves both instead of each ref growing its own copy of the editor.
 *
 * `editingElementId` is the REF's editing focus, not the element's own state: exactly one
 * occupant of a canvas or a composition is in its editor at a time, the engine owns that fact
 * (it publishes it as presence `view.editingElementId`, A2), and a renderer asks to enter and
 * to leave rather than deciding. `removeWhenEmpty` is the one genuine disagreement between the
 * two disciplines: an emptied note is invisible litter on a canvas and must go, while in a tile
 * leaf it IS the leaf's occupant and deleting it would strand the leaf.
 */
export interface ElementHost {
  readonly doc: ElementDocument;
  readonly editingElementId: string | null;
  beginEditing(elementId: string): void;
  endEditing(elementId: string): void;
  readonly removeWhenEmpty: boolean;
}

/**
 * What a contributed element renderer is handed. The engine's element frame owns geometry — one
 * resizer, one selection rule, one commit path for every species — so these are the element's
 * identity and its stored `data`, never a box, a transform or a drag handle.
 *
 * `data` is the element's wire record as its ref projected it, so a renderer reads its own
 * fields defensively (`typeof data["fontSize"] === "number"`): the same document may hold
 * records written by an older version of the plugin, and no schema is imposed here.
 */
export interface ElementProps {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly selected?: boolean | undefined;
}
