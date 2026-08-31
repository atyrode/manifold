import {
  CURSOR_MIN_INTERVAL_MS,
  type ItemKind,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PlacementItem,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";
import { tileIdForSurface } from "@manifold/scene";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  deletePad,
  getMachines,
  removePadTile,
  renamePad,
  renameTerminal,
  type StoredIdentity,
} from "./api.ts";
import { clampCursorFraction, cursorFraction, remoteCursorSocketId } from "./cursor-identity.ts";
import { FlowPadView, sessionUrl } from "./flow-pad-view.tsx";
import { TextSurface } from "./flow-text-node.tsx";
import { ControlIcon, ItemIcon, RemoteCursorIcon, SurfaceIcon } from "./icons.tsx";
import { createPlacementLookup, denialMessage, useItemDrop } from "./item-drop.ts";
import { carriesItem, type ItemEnvelope } from "./item-envelope.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { sessionMachine } from "./machine-visibility.ts";
import { NodeTitleBar } from "./node-titlebar.tsx";
import { TerminalView } from "./terminal-view.tsx";
import { createTileDropStore } from "./tile-drop-store.ts";
import { TilePreviewOverlay } from "./tile-preview-overlay.tsx";
import { TILED_TREE_CLASSES, TileTree } from "./tile-tree.tsx";
import { useTileDrop, type TileDropHost } from "./use-tile-drop.ts";
import { useToast } from "./toast.tsx";
import { carryGhosts, noteTitle, remoteTileCarries, surfaceDisplayLabel } from "./carry.ts";
import { useCarry, useRemoteGestures } from "./use-carry.ts";
import { TileZoneDebug } from "./tile-zone-debug.tsx";
import { REMOTE_CURSOR_FALLBACK_COLOR, useRemoteCursors } from "./use-remote-cursors.ts";

/**
 * The tiled discipline's renderer. A View and a Pad are one container object; this
 * module draws the `layout: "tiled"` half, a recursive flex tree over the scene doc's
 * layout key, while `flow-pad-view.tsx` draws the canvas half.
 *
 * Two invariants shape the code. First, the tree structure — not the ratios — decides
 * React identity: a divider drag only rewrites `ratios`, so every leaf keeps its key
 * and its position in the element tree, and an xterm is never reparented (which would
 * destroy the terminal). Second, structural writes go over HTTP so the server can
 * enforce container discipline and the bubble lifecycle; only the high-frequency,
 * purely geometric ratio write goes straight into the doc.
 */

/** The fallbacks the canvas's note node uses, for the frame between a leaf and its element. */
const NOTE_FALLBACK_FONT_SIZE = 20;
const NOTE_FALLBACK_COLOR = "#f8f9fa";

/**
 * The item kind a leaf's occupant IS, by surface form. A record over the surface union
 * rather than a chain of tests, so a new tileable form cannot be added without saying what
 * the placement algebra should call it.
 */
const SOLO_ITEM_KINDS: Record<TileSurface["kind"], ItemKind> = {
  terminal: "terminal",
  pad: "canvas-pad",
  text: "text",
  panel: "panel",
};

/**
 * What this composition holds when it holds exactly ONE thing — the arity fact the
 * placement algebra looks through. An empty second leaf still counts as a second leaf:
 * splitting is how someone declares a container to be a composition.
 */
function soloOccupancy(
  padId: string,
  layout: TileLayout | null,
): ReadonlyMap<string, PlacementItem> {
  if (layout === null) return NO_SOLO_OCCUPANTS;
  let only: TileSurface | null = null;
  let leaves = 0;
  for (const node of Object.values(layout)) {
    if (node.dir !== null) continue;
    leaves += 1;
    if (leaves > 1 || node.surface === null) return NO_SOLO_OCCUPANTS;
    only = node.surface;
  }
  if (only === null) return NO_SOLO_OCCUPANTS;
  const kind = SOLO_ITEM_KINDS[only.kind];
  return new Map<string, PlacementItem>([[padId, { kind, containerId: padId }]]);
}

const NO_SOLO_OCCUPANTS: ReadonlyMap<string, PlacementItem> = new Map();

interface TiledPadViewProps {
  readonly pad: Pad;
  readonly identity: StoredIdentity;
  /**
   * Every container the sidebar indexes. It is what lets the placement pipeline answer
   * the algebra's discipline question locally — a drag preview has to tell a canvas from
   * a composition without a round trip — and this renderer decides nothing with it.
   */
  readonly pads: readonly Pad[];
  /** Where Shrink returns to: the pad the viewer came from, else the workspace root. */
  readonly originPadId: string | null;
  readonly navigate: (path: string) => void;
  /** Sidebar presence poll, forwarded to canvases embedded as tiles. */
  readonly presence: readonly PadPresence[];
  /** Pin and splits harden a bubble; the sidebar refetches the row to drop the italics. */
  readonly onPadChanged: () => void;
  /**
   * The index's solo-composition fold, handed down the way the canvas already gets it:
   * only the index can see the arity of a container this route merely references, and
   * without it a sidebar terminal row (a solo composition) dropped here would deny
   * `not_solo` instead of merging.
   */
  readonly soloOccupants?: ReadonlyMap<string, PlacementItem>;
  /**
   * Publishes this view's "new terminal" action to the sidebar's Machines section, the
   * way a canvas publishes its whole workspace state — a view has no canvas to author
   * into, so the action must come from the room that will hold the tile. Cleared on
   * unmount so the "+" never outlives the client it would open through.
   */
  readonly onCreateTerminalChange: (create: ((machine?: MachineSummary) => void) | null) => void;
}

export function TiledPadView({
  pad,
  identity,
  pads,
  originPadId,
  navigate,
  presence,
  onPadChanged,
  soloOccupants = NO_SOLO_OCCUPANTS,
  onCreateTerminalChange,
}: TiledPadViewProps) {
  const padId = pad.id;
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), padId, token: identity.token }),
  );
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [layout, setLayout] = useState<TileLayout | null>(null);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  /** The per-frame channel to the preview overlay; only the overlay re-renders on it. */
  const [dropStore] = useState(createTileDropStore);
  /**
   * The element table's version. A note tiled here is an ELEMENT of this room, so its
   * text (and the placement lookup that reads it) needs a reason to re-render.
   */
  const [sceneRevision, setSceneRevision] = useState(0);
  /** Which note tile is in its editor; a note carries no selection model of its own. */
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  /** The tile this browser is carrying, so its leaf can show that it is in flight. */
  const [carriedTileId, setCarriedTileId] = useState<string | null>(null);
  const connectStartedRef = useRef(false);
  /** One delete per view: the confirmed click navigates away, a second would 404. */
  const deletingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Send-cadence gate, the same shape the canvas renderer uses for its own emit. */
  const cursorLastSentRef = useRef(0);
  const remoteCursors = useRemoteCursors(client, "fraction");
  /**
   * The other half of motion. A composition streams and reads carries in the SAME
   * fraction space its cursors use, so a tile crossing this view is drawn where its
   * carrier is holding it whatever window size each viewer has.
   */
  const remoteGestures = useRemoteGestures(client);
  const carry = useCarry({
    client,
    describe: (envelope: ItemEnvelope): string | null =>
      envelope.kind === "terminal" ? (client.sessions.get(envelope.sessionId)?.name ?? null) : null,
  });
  const { notify } = useToast();

  useEffect(() => {
    // The tree is small and read whole: subscribers re-read rather than diff tile ids.
    const readLayout = (): void => {
      setLayout(client.layout());
      setSceneRevision((revision) => revision + 1);
    };
    // A structural change may have hardened the container (a split claims a bubble), so
    // the row is refetched whenever the LEAF COUNT moves — never on ratio drags, which
    // fire layout_changed per pointer frame. Local pin/rename/tile calls refetch directly.
    let lastLeaves = -1;
    const readLayoutAndRow = (): void => {
      const tree = client.layout();
      setLayout(tree);
      const leaves =
        tree === null ? 0 : Object.values(tree).filter((node) => node.dir === null).length;
      if (leaves !== lastLeaves) {
        lastLeaves = leaves;
        onPadChanged();
      }
    };
    const offLayout = client.on("layout_changed", readLayoutAndRow);
    // Notes live in the element table, not the layout tree, so a tiled note's text
    // arrives here and nowhere else.
    const offElements = client.on("elements_changed", () =>
      setSceneRevision((revision) => revision + 1),
    );
    const offInit = client.on("init", readLayout);
    const offReset = client.on("scene_reset", readLayout);
    const offStatus = client.on("status", setStatus);
    readLayout();
    return () => {
      offLayout();
      offElements();
      offInit();
      offReset();
      offStatus();
    };
  }, [client, onPadChanged]);

  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    void client.connect().catch((reason: unknown) => {
      // Sticky: a composition that never connected is a degraded surface, not a passing
      // refusal, so the notice stays until it is dismissed or a later attempt supersedes it.
      notify(reason instanceof Error ? reason.message : "Could not connect to this composition", {
        lifetime: "sticky",
        key: "composition-connect",
      });
    });
    return () => client.close();
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void getMachines(identity.token)
      .then((fetched) => {
        if (!cancelled) setMachines(fetched);
      })
      .catch(() => {
        // Machine badges are decoration; the tiles render without them.
      });
    return () => {
      cancelled = true;
    };
  }, [identity.token]);

  const shrink = useCallback((): void => {
    navigate(originPadId === null ? "/" : `/p/${encodeURIComponent(originPadId)}`);
  }, [navigate, originPadId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to whatever shell has focus inside a tile — vim would be
      // unusable otherwise. It only shrinks the view from the view's own chrome.
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".manifold-terminal") !== null) return;
      shrink();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shrink]);

  const machineFor = useCallback(
    (sessionId: string) => {
      const session = client.sessions.get(sessionId);
      return session === undefined ? null : sessionMachine(machines, session.machineId);
    },
    [client, machines],
  );

  /**
   * A pad tile's bar names its surface. The list the sidebar already fetched IS the
   * index of containers, so an embedded pad's name costs no extra request; a pad
   * created since the last refetch falls back to the bar's own default.
   */
  const padNameFor = useCallback(
    (embeddedPadId: string): string | null =>
      pads.find((candidate) => candidate.id === embeddedPadId)?.name ?? null,
    [pads],
  );
  /** Accessible names must identify the object even before its row is known. */
  const padLabelFor = useCallback(
    (embeddedPadId: string): string => padNameFor(embeddedPadId) ?? embeddedPadId,
    [padNameFor],
  );

  /**
   * The one failure path. Every notice in the application lands in the toast layer now,
   * and the key is the verb, so a repeated failure replaces its own row in place.
   */
  const failed = useCallback(
    (reason: unknown, fallback: string, key: string): void => {
      notify(reason instanceof Error ? reason.message : fallback, { key });
    },
    [notify],
  );

  /** Renaming a composition; the refetched row carries the new name to the index. */
  const rename = useCallback(
    (name: string): void => {
      void renamePad(identity.token, padId, name)
        .then(onPadChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not rename this composition", "rename-view"),
        );
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /**
   * Deleting the container everyone is inside: the viewer leaves the way Shrink
   * leaves, and the sidebar refetch drops the row. Guarded by the ref alone: the
   * click deletes on the spot, and a second call would 404.
   */
  const removeView = useCallback((): void => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    void deletePad(identity.token, padId)
      .then(() => {
        shrink();
        onPadChanged();
      })
      .catch((reason: unknown) => {
        deletingRef.current = false;
        failed(reason, "Could not delete this composition", "delete-view");
      });
  }, [failed, identity.token, onPadChanged, padId, shrink]);

  /** Titlebar rename of a tiled terminal; the room broadcast updates every viewer. */
  const renameTile = useCallback(
    (sessionId: string, name: string): void => {
      void renameTerminal(identity.token, sessionId, name).catch((reason: unknown) =>
        failed(reason, "Could not rename this terminal", "rename-terminal"),
      );
    },
    [failed, identity.token],
  );

  /**
   * Kill: removing a terminal's last leaf IS its destruction — there is no pool to fall
   * back into, so the server reaps the shell with the placement and deletes the
   * composition when this emptied it.
   */
  const closeTile = useCallback(
    (tileId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(onPadChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not close this terminal", "close-terminal"),
        );
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /**
   * A CANVAS tile's minimize: the leaf goes away and the canvas itself is untouched — a
   * canvas is a shared object indexed in the sidebar, so removing its representation
   * from this composition is not ending it. Same endpoint as a terminal's park; the
   * server's park semantics only apply to a session, and a canvas surface has none.
   */
  const detachPadTile = useCallback(
    (tileId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(onPadChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not remove this canvas from the composition", "remove-canvas"),
        );
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /**
   * A CANVAS tile's close: the canvas is deleted for everyone, and the server's delete
   * prunes EVERY reference to it — this leaf included — before the row goes
   * (`deleteContainer` → `removeReferences`). No second removal call: chasing the leaf
   * afterwards always found it already gone and toasted "Could not delete this canvas"
   * over a delete that had succeeded.
   */
  const deletePadTile = useCallback(
    (embeddedPadId: string): void => {
      void deletePad(identity.token, embeddedPadId)
        .then(onPadChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not delete this canvas", "delete-canvas"),
        );
    },
    [failed, identity.token, onPadChanged],
  );

  /**
   * A NOTE tile's close. Removal addresses the LEAF, and the server deletes the note
   * element with it, because a note's leaf is its only placement — there is nowhere else
   * for a note to be, so an orphaned element would be invisible garbage.
   */
  const removeNoteTile = useCallback(
    (tileId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(onPadChanged)
        .catch((reason: unknown) => failed(reason, "Could not delete this note", "delete-note"));
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /**
   * The sidebar's Machines "+" inside a view. There is no canvas to author an element on,
   * so the open frame hands placement to the container and the SERVER writes the leaf —
   * the first empty one, else a split of the root. Placement is not on the session
   * record, so the tile that takes focus is read back out of the live layout: the doc
   * update carrying the leaf precedes the open confirmation on this same socket.
   */
  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      if (client.epoch === "") {
        notify("Waiting for the composition connection", { key: "open-terminal" });
        return;
      }
      const target =
        machine ??
        (machines === null
          ? null
          : chooseDefaultMachine(machines, recallMachine(browserMachineStorage(), padId)));
      if (target !== null) rememberMachine(browserMachineStorage(), padId, target.id);
      try {
        const session = await client.openTerminal({
          elementId: crypto.randomUUID(),
          placement: "tile",
          cols: 80,
          rows: 24,
          ...(target === null ? {} : { machineId: target.id }),
        });
        const placed = tileIdForSurface(client.layout(), {
          kind: "terminal",
          sessionId: session.id,
        });
        if (placed !== null) setFocusedTileId(placed);
      } catch (reason: unknown) {
        failed(reason, "Could not open a terminal in this composition", "open-terminal");
      }
    },
    [client, failed, machines, notify, padId],
  );

  useEffect(() => {
    onCreateTerminalChange((machine) => void createTerminal(machine));
    return () => onCreateTerminalChange(null);
  }, [createTerminal, onCreateTerminalChange]);

  const setRatios = useCallback(
    (splitId: string, ratios: readonly number[]): void => client.setTileRatios(splitId, ratios),
    [client],
  );

  /**
   * Tiled rooms carry view-root FRACTIONS rather than pixels — see `cursorFraction`.
   * The reference box is the tile area, so a fraction resolves to the same tile for
   * every viewer (the ratios that decide the tiles are shared CRDT state) and the
   * header strip never carries a remote cursor.
   */
  const emitCursor = useCallback(
    (clientX: number, clientY: number): void => {
      const body = bodyRef.current;
      if (body === null) return;
      const now = performance.now();
      if (now - cursorLastSentRef.current < CURSOR_MIN_INTERVAL_MS) return;
      cursorLastSentRef.current = now;
      const fraction = cursorFraction(body.getBoundingClientRect(), { x: clientX, y: clientY });
      client.sendCursor(fraction.x, fraction.y);
    },
    [client],
  );

  /**
   * The state the algebra asks about, answered from this composition's own props and
   * document. The server answers the same two questions from its rows and rooms, so a
   * preview painted here can never disagree with the write that follows it.
   */
  const lookup = useMemo(
    () =>
      createPlacementLookup({
        pads,
        self: { padId, layout: "tiled" },
        elements: client.elements,
        // A terminal's home composition rides on its session record, so this room can
        // answer for every terminal it holds without asking the server.
        terminalHomes: new Map(
          [...client.sessions.values()].map((session) => [session.id, session.padId] as const),
        ),
        // The index answers the arity question for every OTHER container (it is the
        // only party that can), and this room answers for ITSELF from its live layout —
        // its own answer wins, because the index's poll can lag a structural write.
        soloOccupants: (() => {
          const merged = new Map(soloOccupants);
          merged.delete(padId);
          for (const [id, item] of soloOccupancy(padId, client.layout())) merged.set(id, item);
          return merged;
        })(),
      }),
    // `sceneRevision` is the element table's version: the lookup reads it live, and this
    // dependency is what makes a preview see a note that arrived a moment ago.
    [client, pads, padId, sceneRevision, soloOccupants],
  );

  const drop = useItemDrop({
    lookup,
    place: (surface, destination) => client.place(surface, destination),
    notify,
    // A landed placement may have hardened a bubble (a second leaf claims the container),
    // so the sidebar row is refetched with the drop.
    onPlaced: () => onPadChanged(),
  });

  /**
   * A tile's minimize: the terminal leaves this composition WITHOUT dying. "Nowhere" is
   * a destination like any other now — the server re-homes the shell into a container of
   * its own, which is exactly what an unplaced terminal is — so this is one placement,
   * not a leaf removal plus a rescue.
   */
  const unplaceTile = useCallback(
    (tileId: string): void => {
      void client
        .place({ kind: "tile", containerId: padId, tileId }, { kind: "unplaced" })
        .then((outcome) => {
          if (!outcome.ok) throw new Error(denialMessage(outcome.denial, lookup));
          onPadChanged();
        })
        .catch((reason: unknown) =>
          failed(reason, "Could not remove this terminal from the composition", "unplace-terminal"),
        );
    },
    [client, failed, lookup, onPadChanged, padId],
  );

  /**
   * What a tiled surface is CALLED here, through the one shared switch: this route
   * supplies the three lookups (its sessions, the container index, its own note
   * elements) and supplies no species logic of its own, so a canvas widget showing the
   * same composition captions the same drag with the same words.
   */
  const surfaceLabel = useCallback(
    (surface: TileSurface | null): string | null =>
      surfaceDisplayLabel(surface, {
        sessionName: (sessionId) => client.sessions.get(sessionId)?.name ?? null,
        padName: padNameFor,
        noteText: (elementId) => {
          const element = client.elements.get(elementId);
          return element?.type === "text" ? element.text : null;
        },
      }),
    [client, padNameFor],
  );

  /** The slot chip names what is in flight, the way a carry ghost does. */
  const carryLabel = useCallback(
    (envelope: ItemEnvelope): string | null => {
      switch (envelope.kind) {
        case "terminal":
          return client.sessions.get(envelope.sessionId)?.name ?? null;
        case "tile":
          return envelope.containerId === padId
            ? surfaceLabel(layout?.[envelope.tileId]?.surface ?? null)
            : null;
        case "canvas":
        case "composition":
          return padNameFor(envelope.padId);
        case "element":
          return null;
        default: {
          const exhaustive: never = envelope;
          return exhaustive;
        }
      }
    },
    [client, layout, padId, padNameFor, surfaceLabel],
  );

  /**
   * THE drop pipeline for this area — ONE instance, created here and handed to the
   * preview overlay, because the memo inside it is also the hysteresis state: a second
   * instance would hold a second zone and the release could commit an aim one
   * transition ahead of the one the eye was shown.
   */
  const dropHost = useMemo<TileDropHost>(
    () => ({
      areaRef,
      layout,
      containerId: padId,
      widget: null,
      dividerPx: TILED_TREE_CLASSES.dividerPx,
      assess: drop.assess,
      describeCarry: carryLabel,
    }),
    [carryLabel, drop.assess, layout, padId],
  );
  const tileDrop = useTileDrop(dropHost);

  const clearDrop = useCallback((): void => {
    dropStore.set({ ...dropStore.get(), pointer: null, armedElementId: null, aim: null });
    tileDrop.clear();
  }, [dropStore, tileDrop]);

  /** A drag that ends anywhere else must not leave the area armed. */
  useEffect(() => {
    const onDragEnd = (): void => clearDrop();
    window.addEventListener("dragend", onDragEnd);
    return () => window.removeEventListener("dragend", onDragEnd);
  }, [clearDrop]);

  /**
   * Every carry crossing this view gets a ghost: unlike a canvas, a composition cannot
   * move a leaf to show the motion — tiles have no free geometry — so the chip under the
   * carrier's pointer IS the live representation here.
   */
  const remoteCarries = useMemo(
    () => carryGhosts(remoteGestures.values(), () => false),
    [remoteGestures],
  );

  // Peers' armed aims, fed to the overlay through the same per-frame channel the local
  // pointer uses — keyed by the container each addresses, because one store can serve
  // several tile areas. Imperative store write: a collaborator's 60 Hz drag repaints
  // the overlay alone, never this tree or its terminals. End frames, the geometry TTL
  // and the much shorter AIM TTL all clear it through the override map, so a vanished
  // carrier can never strand a preview or hold this composition squeezed.
  useEffect(() => {
    dropStore.setRemote(padId, remoteTileCarries(remoteGestures.values()));
  }, [dropStore, padId, remoteGestures]);

  /**
   * A client point in this view's own space. Fractions, like the cursors: the tile area
   * is the reference box, so a carry lands on the same tile for every viewer whatever
   * their window size.
   */
  const bodyFraction = useCallback((clientX: number, clientY: number) => {
    const body = bodyRef.current;
    if (body === null) return null;
    return cursorFraction(body.getBoundingClientRect(), { x: clientX, y: clientY });
  }, []);

  /**
   * A leaf's grab handle. The chrome IS the grip: pressing it starts the one carry, so
   * dragging a tile out of a composition looks to collaborators exactly like dragging a
   * node across a canvas, and the same envelope decides where it may land.
   */
  const gripProps = (tileId: string, label: string | null) => ({
    draggable: true,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onDragStart: (event: ReactDragEvent<HTMLElement>): void => {
      event.stopPropagation();
      setCarriedTileId(tileId);
      carry.begin(
        { kind: "tile", containerId: padId, tileId },
        {
          transfer: event.dataTransfer,
          label,
          ...(() => {
            const at = bodyFraction(event.clientX, event.clientY);
            return at === null ? {} : { at };
          })(),
        },
      );
    },
    onDragEnd: (): void => {
      setCarriedTileId(null);
      carry.end();
    },
  });

  /**
   * The area's drag transport: one handler set on `.tile-area`, replacing N per-leaf
   * sets. Geometry is all this renderer contributes — the pointer goes into the store
   * for the overlay to preview, and every question about what may land where belongs
   * to the pipeline — which is why there is no rule in any handler below.
   */
  const areaDropProps = {
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer)) return;
      // Claimed even when refused: keeping the gesture is what lets the overlay paint
      // the declared RULE, instead of the browser showing a bare no-drop cursor that
      // explains nothing. The `dropEffect` still says "none", so the cursor stays honest.
      event.preventDefault();
      event.stopPropagation();
      // Pointer FIRST, then read the answer — the same order the canvas transports use,
      // so aim staleness is one frame everywhere instead of one here and two there.
      // Arm delay 0: the route previews on the first dragover frame.
      dropStore.set({
        ...dropStore.get(),
        pointer: { clientX: event.clientX, clientY: event.clientY },
        armedElementId: null,
      });
      // The carry streams from every frame that crosses this view, whether it began on
      // a leaf here or on a row in the sidebar — motion is the same concept either way.
      // The aim it carries is the PUBLISHED one: the overlay is the single producer of
      // the wire aim on both renderers, so what peers re-derive is what was painted
      // here, never a second resolution running beside it.
      const at = bodyFraction(event.clientX, event.clientY);
      if (at !== null) carry.track(at, dropStore.get().aim?.tile);
      // This browser's own cue comes from the one pipeline instance the overlay paints
      // from, so the cursor and the preview can never disagree about legality.
      const state = tileDrop.aimAt(event.clientX, event.clientY);
      event.dataTransfer.dropEffect =
        state !== null && state.assessment?.denial == null ? "move" : "none";
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
      clearDrop();
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      // The drop's own pointer decides the destination, re-resolved against the live
      // layout. Reading the painted state instead would race the render that drew it.
      const state = tileDrop.aimAt(event.clientX, event.clientY);
      const at = bodyFraction(event.clientX, event.clientY);
      // The ghost is retired before the write: the payload is in the transfer, so
      // ending the carry here cannot cost the drop its envelope.
      carry.end(at ?? undefined);
      setCarriedTileId(null);
      clearDrop();
      // Released between zones (a divider, the carry's own leaf): aborting with no
      // mutation and no toast is the documented escape.
      if (state === null) return;
      drop.commit(event.dataTransfer, state.destination);
    },
  };

  /**
   * A leaf's occupant. One arm per tileable species, and the switch is exhaustive on
   * purpose: the protocol cannot grow a fourth surface without this frame growing a way
   * to draw it.
   */
  const renderSurface = (node: TileNode, surface: TileSurface | null): ReactNode => {
    if (surface === null) {
      return (
        <div className="tiled-empty">
          <span className="tiled-empty-glyph" aria-hidden="true">
            <ItemIcon kind="composition" size={22} />
          </span>
          <span>Drop a terminal, a canvas or a note here</span>
        </div>
      );
    }
    switch (surface.kind) {
      case "terminal":
        return (
          <TerminalView
            key={`${node.id}:${surface.sessionId}`}
            client={client}
            sessionId={surface.sessionId}
            elementId={node.id}
            active={focusedTileId === node.id}
            panelHighlighted={false}
            machine={machineFor(surface.sessionId)}
            // Minimize takes the terminal OUT of the composition (it lives on, unplaced);
            // close ends it. There is no expand: a terminal inside a composition is
            // already where it lives, and the composition's own bar is one row up.
            onPark={() => unplaceTile(node.id)}
            onClose={() => closeTile(node.id)}
            onRenameTitle={(name) => renameTile(surface.sessionId, name)}
          />
        );
      case "pad":
        return (
          /*
            A canvas tile wears the same bar as every other placed object. Maximize is the
            load-bearing control: an embedded board is a BOARD — its interior belongs to
            React Flow, panning and all — so the titlebar is the only door INTO the canvas
            from here. Minimize drops just this representation; close deletes the canvas
            for everyone, on the click.

            The bar sits ABOVE the board rather than over it, so nothing about the
            embedded canvas's own pointer handling changes.
          */
          <div className="tiled-pad-tile">
            <NodeTitleBar
              className="tiled-pad-tile__bar"
              icon={<ItemIcon kind="canvas" size={13} />}
              title={padNameFor(surface.padId)}
              defaultTitle="canvas"
              onMinimize={() => detachPadTile(node.id)}
              minimizeLabel={`Remove canvas ${padLabelFor(surface.padId)} from this composition`}
              minimizeTooltip="Remove this canvas from the composition (the canvas keeps existing)"
              onMaximize={() => navigate(`/p/${encodeURIComponent(surface.padId)}`)}
              maximizeLabel={`Open canvas ${padLabelFor(surface.padId)}`}
              maximizeTooltip="Open this canvas"
              onClose={() => deletePadTile(surface.padId)}
              closeLabel={`Delete canvas ${padLabelFor(surface.padId)}`}
              closeTooltip="Delete this canvas for everyone"
            />
            <div className="tiled-pad-tile__body">
              <FlowPadView
                key={surface.padId}
                padId={surface.padId}
                identity={identity}
                depth={2}
                navigate={navigate}
                presence={presence}
                // The embedded canvas answers the algebra from the same container index
                // this composition was handed; without it its own previews would be blind.
                pads={pads}
                // The sidebar's session panel belongs to the route-level container, not
                // to a canvas embedded three levels down inside it.
                onWorkspaceChange={() => undefined}
              />
            </div>
          </div>
        );
      case "text": {
        // A note has no identity outside the container holding it, so the element is
        // always in THIS room's document. It is missing only for the frame between a
        // placement landing in the layout and the element arriving with it.
        const element = client.elements.get(surface.elementId);
        const note = element?.type === "text" ? element : null;
        const text = note?.text ?? "";
        return (
          /*
            A note tile borrows the canvas tile's frame — `.tiled-pad-tile` is the bar/body
            rhythm every embedded object wears — and edits the SAME `Y.Text` it would edit
            on a canvas, through the room this composition is joined to.
          */
          <div className="tiled-pad-tile">
            <NodeTitleBar
              className="tiled-pad-tile__bar"
              icon={<ItemIcon kind="note" size={13} />}
              title={noteTitle(text)}
              defaultTitle="note"
              // Close, not minimize: a note's leaf is its ONLY placement, so the server
              // deletes the note element together with the leaf. There is no "remove the
              // representation" for an object that exists nowhere else.
              onClose={() => removeNoteTile(node.id)}
              closeLabel="Delete note"
              closeTooltip="Delete this note"
            />
            <div className="tiled-pad-tile__body">
              <TextSurface
                client={client}
                elementId={surface.elementId}
                text={text}
                fontSize={note?.fontSize ?? NOTE_FALLBACK_FONT_SIZE}
                color={note?.color ?? NOTE_FALLBACK_COLOR}
                editing={editingNoteId === surface.elementId}
                onBeginEditing={() => setEditingNoteId(surface.elementId)}
                onEndEditing={() => setEditingNoteId(null)}
                // The element IS the leaf's occupant: emptying the note must not delete
                // it, or the leaf would be left with nothing to render.
                removeWhenEmpty={false}
              />
            </div>
          </div>
        );
      }
      case "panel":
        /*
          Panels are leaves of a PRINCIPAL's workspace layout, not of a pad's document, so
          this route never legitimately draws one — the shell does, through its panel
          outlet. Rendering the inert placeholder keeps a stray leaf visible and nameable
          instead of blanking the tile.
        */
        return <div className="plugin-placeholder">{surface.panelId}</div>;
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  };

  const renderLeaf = (node: TileNode): ReactNode => (
    <div
      className={`tiled-leaf${focusedTileId === node.id ? " is-focused" : ""}${
        carriedTileId === node.id ? " is-carried" : ""
      }`}
      onPointerDownCapture={() => setFocusedTileId(node.id)}
    >
      {renderSurface(node, node.surface)}
      {node.surface === null ? null : (
        /*
          The grip is this leaf's chrome-as-handle. A terminal tile's own titlebar
          cannot be it — xterm needs the bar for rename and the frame swallows
          pointerdown — so every species wears the same corner handle the widget's
          tiles wear on a canvas, and the gesture behind it is the same carry.
        */
        <div
          className="tiled-leaf__grip"
          title="Drag to move this tile — onto a canvas to pull it out"
          {...gripProps(node.id, surfaceLabel(node.surface))}
        >
          <ControlIcon kind="grip" size={12} />
        </div>
      )}
    </div>
  );

  const body =
    layout === null ? (
      <div className="tiled-placeholder">
        {status === "open" ? "Preparing this view…" : "Connecting to this view…"}
      </div>
    ) : (
      /*
        THE tile tree — the same component a container widget draws on a canvas. Here it
        is always interactive: this route is an occupant socket by construction, so a
        divider drag writes the ratios straight into the doc.
      */
      <TileTree
        layout={layout}
        classes={TILED_TREE_CLASSES}
        interactive
        onRatios={setRatios}
        renderLeaf={renderLeaf}
      />
    );

  return (
    <div className="tiled-pad-view">
      <NodeTitleBar
        className="tiled-header"
        icon={<ItemIcon kind="composition" size={15} />}
        title={pad.name}
        defaultTitle="view"
        onRenameTitle={rename}
        extraActions={<span className={`tiled-status is-${status}`}>{status}</span>}
        onMaximize={shrink}
        maximizeControl="shrink"
        maximizeLabel="Shrink view"
        maximizeTooltip="Leave this view (Esc)"
        onClose={removeView}
        closeLabel={`Delete view ${pad.name}`}
        closeTooltip="Delete this view for everyone"
      />
      {/*
        Capture phase, wired on the tile area rather than on each leaf: xterm owns the
        pointer inside a terminal, and with mouse tracking on (DECSET 1003) it handles
        motion itself. A capture-phase listener on an ancestor runs before the target's
        own handlers, so every move over a live terminal still reaches us — measured, not
        assumed: a probe sweeping a tracking-enabled xterm delivered 11 of 11 moves here,
        each targeting `.xterm-screen`. A canvas embedded as a tile keeps its own capture
        handler and emits React-Flow coordinates to its own room; the two disciplines
        share this DOM subtree, never a coordinate space.
      */}
      <div
        className="tiled-body"
        ref={bodyRef}
        onPointerMoveCapture={(event) => emitCursor(event.clientX, event.clientY)}
      >
        {/*
          The tile AREA: the one DOM object drop geometry measures (chrome excluded by
          construction), the drag transport's single handler set, and the overlay's
          unambiguous root — its `firstElementChild` is the tree, which is what the
          FLIP falls back to when a single-leaf tree renders no pane box.
        */}
        <div className="tile-area" ref={areaRef} {...areaDropProps}>
          {body}
          <TilePreviewOverlay drop={tileDrop} store={dropStore} surfaceLabel={surfaceLabel} />
          <TileZoneDebug
            layout={layout}
            areaRef={areaRef}
            dividerPx={TILED_TREE_CLASSES.dividerPx}
          />
        </div>
        <div className="tiled-presence-layer" aria-hidden="true">
          {remoteCursors.cursors.map((cursor) => {
            const color = remoteCursors.colorFor(cursor);
            const fraction = clampCursorFraction(cursor);
            return (
              <div
                className="flow-remote-cursor"
                data-cursor-color={color ?? ""}
                key={remoteCursorSocketId(cursor.principalId, cursor.connId)}
                style={{
                  color: color ?? REMOTE_CURSOR_FALLBACK_COLOR,
                  left: `${String(fraction.x * 100)}%`,
                  top: `${String(fraction.y * 100)}%`,
                }}
              >
                <RemoteCursorIcon />
                <span>{remoteCursors.labelFor(cursor)}</span>
              </div>
            );
          })}
          {/*
            A collaborator's carry. Every carry gets a ghost here: a composition has no
            free geometry to move a leaf through, so the chip under their pointer is the
            only way the motion is visible — while the source leaf wears `is-carried`
            for the person holding it.
          */}
          {remoteCarries.map((ghost) => (
            <div
              className="carry-ghost"
              data-carry-kind={ghost.kind}
              key={ghost.key}
              style={{
                borderColor:
                  client.roster.get(ghost.principalId)?.principal.color ??
                  REMOTE_CURSOR_FALLBACK_COLOR,
                left: `${String(ghost.x * 100)}%`,
                top: `${String(ghost.y * 100)}%`,
              }}
            >
              <span className="carry-ghost__glyph" aria-hidden="true">
                <SurfaceIcon kind={ghost.kind} size={12} />
              </span>
              <span className="carry-ghost__label">{ghost.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
