import {
  CURSOR_MIN_INTERVAL_MS,
  ROOT_TILE_ID,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PlacementDestination,
  type TileEdge,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";
import { tileIdForSurface } from "@manifold/scene";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  Fragment,
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
  expandTerminal,
  getMachines,
  killPooledTerminal,
  pinPad,
  removePadTile,
  renamePad,
  renameTerminal,
  type StoredIdentity,
} from "./api.ts";
import { clampCursorFraction, cursorFraction, remoteCursorSocketId } from "./cursor-identity.ts";
import { FlowPadView, sessionUrl } from "./flow-pad-view.tsx";
import { TextSurface } from "./flow-text-node.tsx";
import { createPlacementLookup, useItemDrop, type ItemDropAssessment } from "./item-drop.ts";
import { carriesItem } from "./item-envelope.ts";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";
import { sessionMachine } from "./machine-visibility.ts";
import { NodeTitleBar } from "./node-titlebar.tsx";
import { TerminalView } from "./terminal-view.tsx";
import { previewRect, resizeRatios, snapZone } from "./tile-snap.ts";
import { useToast } from "./toast.tsx";
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

/** The tile currently under a drag, with the zone its pointer resolved to. */
interface TileDropTarget {
  readonly tileId: string;
  readonly zone: TileEdge;
  /**
   * What the placement pipeline says about the live carry at this zone: null when
   * nothing is being carried, `denial: null` when the drop is legal. The leaf paints
   * itself from this and from nothing else — no rule is decided here.
   */
  readonly assessment: ItemDropAssessment | null;
}

/** Percent-space rect for the snap overlay: the leaf box is its own coordinate system. */
const LEAF_BOX = { x: 0, y: 0, width: 100, height: 100 } as const;

/** The fallbacks the canvas's note node uses, for the frame between a leaf and its element. */
const NOTE_FALLBACK_FONT_SIZE = 20;
const NOTE_FALLBACK_COLOR = "#f8f9fa";
/** Past this a note's first line stops being a name and starts being the note. */
const NOTE_TITLE_LENGTH = 40;

/**
 * A note has no name, so its bar borrows its first line — the only handle a note has.
 * Null while the note is empty, which is what makes the bar fall back to "note".
 */
function noteTitle(text: string): string | null {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length <= NOTE_TITLE_LENGTH
    ? firstLine
    : `${firstLine.slice(0, NOTE_TITLE_LENGTH - 1)}…`;
}

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
  const [dropTarget, setDropTarget] = useState<TileDropTarget | null>(null);
  /**
   * The element table's version. A note tiled here is an ELEMENT of this room, so its
   * text (and the placement lookup that reads it) needs a reason to re-render.
   */
  const [sceneRevision, setSceneRevision] = useState(0);
  /** Which note tile is in its editor; a note carries no selection model of its own. */
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const connectStartedRef = useRef(false);
  /** One delete per view: the confirmed click navigates away, a second would 404. */
  const deletingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Send-cadence gate, the same shape the canvas renderer uses for its own emit. */
  const cursorLastSentRef = useRef(0);
  const remoteCursors = useRemoteCursors(client, "fraction");
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

  const pin = useCallback((): void => {
    setPinning(true);
    void pinPad(identity.token, padId)
      .then(onPadChanged)
      .catch((reason: unknown) => failed(reason, "Could not pin this composition", "pin-view"))
      .finally(() => setPinning(false));
  }, [failed, identity.token, onPadChanged, padId]);

  /**
   * Renaming a view claims it: the server clears `transient`, so the refetched row
   * loses its bubble italics with the same round trip that changes the name.
   */
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
   * leaves, and the sidebar refetch drops the row. Guarded by the titlebar's
   * two-step confirm and by the ref, because the second call would 404.
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
   * Full parity with a pad: a tile's terminal keeps the bar it would wear anywhere,
   * expand included. The server handles the tiled origin — it removes the leaf this
   * session left behind instead of swapping a canvas element for a portal.
   */
  const expandTile = useCallback(
    (sessionId: string): void => {
      void expandTerminal(identity.token, sessionId)
        .then((viewId) => {
          navigate(`/p/${encodeURIComponent(viewId)}`);
        })
        .catch((reason: unknown) =>
          failed(reason, "Could not expand this terminal", "expand-terminal"),
        );
    },
    [failed, identity.token, navigate],
  );

  /** Park semantics: the server unbinds the session back to the pool when it was the last placement. */
  const parkTile = useCallback(
    (tileId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(onPadChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not park this terminal", "park-terminal"),
        );
    },
    [failed, identity.token, onPadChanged, padId],
  );

  /** Kill: drop the leaf first, then end the PTY the removal parked into the pool. */
  const closeTile = useCallback(
    (tileId: string, sessionId: string): void => {
      void removePadTile(identity.token, padId, tileId)
        .then(() => killPooledTerminal(identity.token, sessionId))
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
   * A CANVAS tile's close: the canvas is deleted for everyone and its leaf goes with it,
   * because a tile onto a deleted container is a hole. The same order the canvas's own
   * portal widget uses (delete, then drop the representation), so a failed delete leaves
   * the tile in place rather than silently emptying it.
   */
  const deletePadTile = useCallback(
    (tileId: string, embeddedPadId: string): void => {
      void deletePad(identity.token, embeddedPadId)
        .then(() => removePadTile(identity.token, padId, tileId))
        .then(onPadChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not delete this canvas", "delete-canvas"),
        );
    },
    [failed, identity.token, onPadChanged, padId],
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
      }),
    // `sceneRevision` is the element table's version: the lookup reads it live, and this
    // dependency is what makes a preview see a note that arrived a moment ago.
    [client, pads, padId, sceneRevision],
  );

  const drop = useItemDrop({
    lookup,
    place: (surface, destination) => client.place(surface, destination),
    notify,
    // A landed placement may have hardened a bubble (a second leaf claims the container),
    // so the sidebar row is refetched with the drop.
    onPlaced: () => onPadChanged(),
  });

  const zoneAt = (
    target: HTMLDivElement,
    pointer: { readonly clientX: number; readonly clientY: number },
  ): TileEdge | null => {
    const bounds = target.getBoundingClientRect();
    return snapZone(
      { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
      { x: pointer.clientX, y: pointer.clientY },
    );
  };

  /**
   * The destination one leaf means. Geometry is all this renderer contributes: the zone
   * comes from the pointer, and every question about what may land there belongs to the
   * pipeline — which is why there is no rule in either handler below.
   */
  const destinationFor = (tileId: string, zone: TileEdge): PlacementDestination => ({
    kind: "tile",
    padId,
    targetTileId: tileId,
    edge: zone,
  });

  const dropProps = (tileId: string) => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer)) return;
      // Claimed even when refused: keeping the gesture is what lets the leaf paint the
      // declared RULE, instead of the browser showing a bare no-drop cursor that explains
      // nothing. The `dropEffect` still says "none", so the cursor stays honest.
      event.preventDefault();
      event.stopPropagation();
      const zone = zoneAt(event.currentTarget, event);
      if (zone === null) {
        event.dataTransfer.dropEffect = "none";
        setDropTarget((current) => (current?.tileId === tileId ? null : current));
        return;
      }
      const assessment = drop.assess(destinationFor(tileId, zone));
      event.dataTransfer.dropEffect = assessment?.denial == null ? "move" : "none";
      setDropTarget((current) => {
        // Compared by RULE rather than by assessment identity: `assess` hands back a fresh
        // object every frame, and a drag fires this handler per pointer move.
        if (
          current?.tileId === tileId &&
          current.zone === zone &&
          (current.assessment?.denial?.rule ?? null) === (assessment?.denial?.rule ?? null)
        ) {
          return current;
        }
        return { tileId, zone, assessment };
      });
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
      setDropTarget((current) => (current?.tileId === tileId ? null : current));
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      // The drop's own pointer decides the edge. Reading the highlight state instead
      // would race the render that painted it, and a drop is a one-shot event.
      const zone = zoneAt(event.currentTarget, event);
      setDropTarget(null);
      // Released between zones: aborting with no mutation is the documented escape.
      if (zone === null) return;
      drop.commit(event.dataTransfer, destinationFor(tileId, zone));
    },
  });

  /**
   * A BUBBLE is a transient container whose whole layout is one terminal: an
   * expanded terminal, not a view yet. It wears NO view header — the terminal's own
   * titlebar is the only top bar, and it carries the two view-level controls that
   * still make sense there (Pin claims the container, the maximize slot shrinks out
   * of it). Pinning or splitting transmutes the header in place: the container
   * becomes a real view and grows the dedicated bar below.
   */
  const leaves = layout === null ? [] : Object.values(layout).filter((node) => node.dir === null);
  const onlyLeaf = leaves.length === 1 ? leaves[0] : undefined;
  const bubbleLeaf =
    // Notes are tileable now, so "one leaf" stopped being a synonym for "one terminal":
    // a transient container holding a single NOTE is a composition with a note in it,
    // never a bubble, because there is no terminal titlebar to hang the view chrome on.
    pad.transient && onlyLeaf?.surface?.kind === "terminal" ? onlyLeaf : null;

  /**
   * One Pin control for both headers — a bubble wears it in its terminal's bar, a
   * still-unclaimed view in its own — with the accessible name the gate looks for.
   */
  const pinControl = (
    <button
      className="node-titlebar__ctl tiled-pin"
      type="button"
      disabled={pinning}
      title="Keep this view after everyone leaves"
      aria-label={`Pin view ${pad.name}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={pin}
    >
      ⚑
    </button>
  );

  /**
   * A leaf's occupant. One arm per tileable species, and the switch is exhaustive on
   * purpose: the protocol cannot grow a fourth surface without this frame growing a way
   * to draw it.
   */
  const renderSurface = (node: TileNode, surface: TileSurface | null): ReactNode => {
    if (surface === null) {
      return (
        <div className="tiled-empty">
          <span className="tiled-empty-glyph" aria-hidden="true" />
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
            onPark={() => parkTile(node.id)}
            onClose={() => closeTile(node.id, surface.sessionId)}
            onRenameTitle={(name) => renameTile(surface.sessionId, name)}
            {...(bubbleLeaf?.id === node.id
              ? // Bubble: the terminal's bar IS the view's bar. Its maximize slot
                // shrinks (it is already as big as it gets) and Pin claims the
                // container the terminal is temporarily wearing.
                { onShrink: shrink, titlebarExtras: pinControl }
              : // A real composition's tile wears the bar it would wear on a canvas,
                // expand included: the server turns a tile expand into a new view and
                // drops the leaf this session leaves behind.
                { onExpand: () => expandTile(surface.sessionId) })}
          />
        );
      case "pad":
        return (
          /*
            A canvas tile wears the same bar as every other placed object. Maximize is the
            load-bearing control: an embedded board is a BOARD — its interior belongs to
            React Flow, panning and all — so the titlebar is the only door INTO the canvas
            from here. Minimize drops just this representation; close deletes the canvas
            for everyone behind the bar's own two-step confirm.

            The bar sits ABOVE the board rather than over it, so nothing about the
            embedded canvas's own pointer handling changes.
          */
          <div className="tiled-pad-tile">
            <NodeTitleBar
              className="tiled-pad-tile__bar"
              icon="▦"
              title={padNameFor(surface.padId)}
              defaultTitle="canvas"
              onMinimize={() => detachPadTile(node.id)}
              minimizeLabel={`Remove canvas ${padLabelFor(surface.padId)} from this composition`}
              minimizeTooltip="Remove this canvas from the composition (the canvas keeps existing)"
              onMaximize={() => navigate(`/p/${encodeURIComponent(surface.padId)}`)}
              maximizeLabel={`Open canvas ${padLabelFor(surface.padId)}`}
              maximizeTooltip="Open this canvas"
              onClose={() => deletePadTile(node.id, surface.padId)}
              closeLabel={`Delete canvas ${padLabelFor(surface.padId)}`}
              closeTooltip="Delete this canvas for everyone"
              closeConfirm={`Delete “${padNameFor(surface.padId) ?? "this canvas"}”?`}
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
              icon="✎"
              title={noteTitle(text)}
              defaultTitle="note"
              // Close, not minimize: a note's leaf is its ONLY placement, so the server
              // deletes the note element together with the leaf. There is no "remove the
              // representation" for an object that exists nowhere else.
              onClose={() => removeNoteTile(node.id)}
              closeLabel="Delete note"
              closeTooltip="Delete this note"
              closeConfirm="Delete this note?"
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
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  };

  const renderLeaf = (node: TileNode): ReactNode => {
    const highlight = dropTarget?.tileId === node.id ? dropTarget : null;
    const zone = highlight?.zone ?? null;
    const assessment = highlight?.assessment ?? null;
    const denied = assessment?.denial != null;
    const preview = zone === null ? null : previewRect(LEAF_BOX, zone);
    return (
      <div
        className={`tiled-leaf${focusedTileId === node.id ? " is-focused" : ""}${
          zone === null || denied ? "" : " is-drop-target"
        }`}
        onPointerDownCapture={() => setFocusedTileId(node.id)}
        {...dropProps(node.id)}
        // Empty while the drop is legal, so the refusal cue exists only when refusing.
        {...drop.refusalProps(assessment)}
      >
        {renderSurface(node, node.surface)}
        {preview === null ? null : (
          <div
            className={`tiled-snap-preview${denied ? " is-denied" : ""}`}
            aria-hidden="true"
            style={{
              left: `${preview.x}%`,
              top: `${preview.y}%`,
              width: `${preview.width}%`,
              height: `${preview.height}%`,
            }}
          >
            {assessment?.message == null ? null : (
              <span className="drop-denial-note">{assessment.message}</span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderTile = (tileId: string): ReactNode => {
    const node = layout?.[tileId];
    if (node === undefined) return null;
    if (node.dir === null) return renderLeaf(node);
    return <TileSplit node={node} renderChild={renderTile} onRatios={setRatios} />;
  };

  const body =
    layout === null ? (
      <div className="tiled-placeholder">
        {status === "open" ? "Preparing this view…" : "Connecting to this view…"}
      </div>
    ) : (
      renderTile(ROOT_TILE_ID)
    );

  return (
    <div className="tiled-pad-view">
      {bubbleLeaf === null ? (
        <NodeTitleBar
          className="tiled-header"
          icon="▤"
          title={pad.name}
          defaultTitle="view"
          onRenameTitle={rename}
          middle={
            pad.transient ? (
              <span className="tiled-bubble-chip" title="Dissolves when its last occupant leaves">
                bubble
              </span>
            ) : null
          }
          extraActions={
            <>
              <span className={`tiled-status is-${status}`}>{status}</span>
              {pad.transient ? pinControl : null}
            </>
          }
          onMaximize={shrink}
          maximizeGlyph="shrink"
          maximizeLabel="Shrink view"
          maximizeTooltip="Leave this view (Esc)"
          onClose={removeView}
          closeLabel={`Delete view ${pad.name}`}
          closeTooltip="Delete this view for everyone"
          closeConfirm={`Delete “${pad.name}”?`}
        />
      ) : null}
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
        {body}
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
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 2 20 12l-8 2-4 7Z" fill="currentColor" />
                </svg>
                <span>{remoteCursors.labelFor(cursor)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface TileSplitProps {
  readonly node: TileNode;
  readonly renderChild: (tileId: string) => ReactNode;
  readonly onRatios: (splitId: string, ratios: readonly number[]) => void;
}

/** Live divider state; kept in a ref so a drag never re-renders the terminals it moves. */
interface DividerDrag {
  readonly index: number;
  readonly originPx: number;
  readonly sizePx: number;
  readonly total: number;
  readonly ratios: readonly number[];
}

/**
 * One split. Children are laid out with `flex-grow`, so a ratio change is a style
 * mutation on boxes React already owns: no child unmounts, no xterm is reparented.
 */
function TileSplit({ node, renderChild, onRatios }: TileSplitProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DividerDrag | null>(null);
  const row = node.dir === "row";

  const beginDrag = (index: number, event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = boxRef.current;
    if (box === null) return;
    const bounds = box.getBoundingClientRect();
    const sizePx = row ? bounds.width : bounds.height;
    if (sizePx <= 0) return;
    let total = 0;
    for (const ratio of node.ratios) total += ratio;
    dragRef.current = {
      index,
      originPx: row ? event.clientX : event.clientY,
      sizePx,
      total,
      ratios: node.ratios,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const deltaPx = (row ? event.clientX : event.clientY) - drag.originPx;
    const next = resizeRatios(drag.ratios, drag.index, (deltaPx / drag.sizePx) * drag.total);
    // resizeRatios hands back the same array when the drag is pinned; skipping the
    // write there keeps a stalled drag from spamming the doc with no-op updates.
    if (next !== drag.ratios) onRatios(node.id, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className={`tiled-split is-${node.dir ?? "leaf"}`} ref={boxRef}>
      {node.children.map((childId, index) => (
        // Keyed by tile id, never by position: removing a leaf must not shift its
        // siblings onto each other's keys, which would tear down live terminals.
        <Fragment key={childId}>
          {index === 0 ? null : (
            <div
              className="tiled-divider"
              role="separator"
              aria-orientation={row ? "vertical" : "horizontal"}
              aria-label="Resize tiles"
              onPointerDown={(event) => beginDrag(index - 1, event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          )}
          <div className="tiled-pane" style={{ flexGrow: node.ratios[index] ?? 1 }}>
            {renderChild(childId)}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
