import type {
  ActionOutcome,
  Cap,
  MachineSummary,
  Pad,
  PadPresence,
  PadSessionSummary,
  PadTreeItem,
  PlaceResponse,
  PlacementDenial,
  PlacementDestination,
  PlacementSurface,
  PluginRoster,
  TerminalSummary,
} from "@manifold/protocol";
import type { ScenePatch, Y } from "@manifold/scene";

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
 * The session surface a plugin is handed. It is deliberately the SDK's own surface described
 * structurally: `SessionClient` satisfies it without importing anything from here, so a
 * plugin talks to the server through exactly the doors a stranger's agent has, and nothing
 * else. Whatever is not on this interface is not reachable from plugin code — that is the
 * sandbox shape (ADR 0010) the contracts keep even while plugins run in-process.
 */
export interface SessionHandle {
  /** Invoke an action by its FULL name (`core.terminals.rename`); a denial is data, not a throw. */
  action(name: string, args: unknown): Promise<ActionOutcome>;
  /** THE placement call: put an item in a container. */
  place(surface: PlacementSurface, destination: PlacementDestination): Promise<PlaceOutcome>;
  /** The caller's own caps, as the server granted them: what UI to offer, and what to gray out. */
  selfCaps(): readonly Cap[];
  machines(): Promise<readonly MachineSummary[]>;
  padTree(): Promise<readonly PadTreeItem[]>;
  padPresence(): Promise<readonly PadPresence[]>;
  padSessions(): Promise<readonly PadSessionSummary[]>;
  terminals(): Promise<readonly TerminalSummary[]>;
  /*
    The workspace index's own writes. They are HTTP routes rather than actions this wave
    (AXIOMS.md §Roadmap: "pad/folder CRUD + tree moves → workspace-index actions"), so the
    plugin that renders the index reaches them through the same handle it reads with — one
    door per concept, and the section that lists containers is also the one that renames
    them. When those routes become actions these methods go away and `action()` carries
    them; nothing else about the section changes.
   */
  renamePad(padId: string, name: string): Promise<Pad>;
  deletePad(padId: string): Promise<void>;
  createPadFolder(name: string, parentId: string | null): Promise<readonly PadTreeItem[]>;
  renamePadFolder(folderId: string, name: string): Promise<readonly PadTreeItem[]>;
  deletePadFolder(folderId: string): Promise<readonly PadTreeItem[]>;
  movePadTreeItem(
    item: { readonly kind: "pad" | "folder"; readonly id: string },
    parentId: string | null,
    index: number,
  ): Promise<readonly PadTreeItem[]>;
}

/**
 * The viewport of the pad currently on screen, when one is. Plugins never reach into the
 * renderer: they ask the host to move the view (a spotlight lands here) and to report where
 * it is. Null when no pad view is mounted — the workspace root, for instance.
 */
export interface PadViewportHandle {
  centerOn(uri: string): void;
  viewport(): { x: number; y: number; zoom: number } | null;
}

/**
 * The last spotlight this client APPLIED, as a `manifold://` URI. One mutable slot, because
 * "what did the viewport actually do" has exactly one answer per device.
 *
 * It lives in the engine because its writer and its reader are on opposite sides of the
 * plugin boundary and must not import each other: `core.presence` applies a spotlight and
 * records it here, and the web floor's debug seam (`ManifoldDebugSeam.lastSpotlight`, read by
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
 * The mounted pad view's authoring door. A terminal is born INSIDE a container, and only
 * the renderer on screen knows how its discipline authors one (a canvas writes an element,
 * a composition lets the server place a tile) — so a plugin asks for the birth instead of
 * performing it. Null when no view is mounted, or when the mounted view cannot author:
 * exactly the case where the affordance must not be offered.
 */
export interface PadAuthoringHandle {
  createTerminal(machine?: MachineSummary): void;
}

/**
 * The composition, as DATA. A plugin that administers plugins needs to read the roster it
 * is listing; it must not be able to compose, register, or override anything — so this is
 * two questions, both answers, no levers. Mutating the composition is an action
 * (`engine.plugins.setEnabled`, the engine's own builtin door), like every other
 * authority-bearing change.
 */
export interface CompositionFacet {
  roster(): PluginRoster;
  enabled(id: string): boolean;
}

/**
 * Everything a plugin may touch outside itself, all of it addressed: talk to the server
 * (`client`), send the viewer somewhere by `manifold://` URI (`navigate`), move the mounted
 * pad's viewport (`viewport`), author into it (`authoring`), and read the composition
 * (`composition`). No host internals, no React context of the shell, no DOM handles — a
 * contribution that needs more needs a new declared contract.
 */
export interface HostServices {
  readonly client: SessionHandle;
  /**
   * The container the viewer is looking at, or null at the workspace root. Read-only and
   * declared rather than inferred: an index that cannot mark its own active row would have
   * to guess from the URL, and A2 makes "where a principal is" observable state, not a
   * private fact of one renderer. Change it by calling `navigate`.
   */
  readonly padId: string | null;
  navigate(uri: string): void;
  readonly viewport: PadViewportHandle | null;
  readonly authoring: PadAuthoringHandle | null;
  readonly composition: CompositionFacet;
}

/** A contributed panel: a tile-surface leaf, including the workspace shell's own two. */
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
 * document is synchronised. Like {@link SessionHandle} this is the SDK's own surface restated
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
 * one renderer serves both instead of each surface growing its own copy of the editor.
 *
 * `editingElementId` is the SURFACE's editing focus, not the element's own state: exactly one
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
 * `data` is the element's wire record as its surface projected it, so a renderer reads its own
 * fields defensively (`typeof data["fontSize"] === "number"`): the same document may hold
 * records written by an older version of the plugin, and no schema is imposed here.
 */
export interface ElementProps {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly selected?: boolean | undefined;
}
