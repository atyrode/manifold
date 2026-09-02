import {
  CURSOR_MIN_INTERVAL_MS,
  elementString,
  elementPayload,
  placementItemFor,
  soloLeaf,
  type MachineSummary,
  type PlacementItem,
  type TileLayout,
  type Tile,
  type TileRef,
} from "@manifold/protocol";
import { tileIdForRef } from "@manifold/scene";
import { SessionClient, type ConnectionStatus } from "@manifold/sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { itemNoun } from "@manifold/plugin";
import {
  ControlIcon,
  Cover,
  ItemIcon,
  NodeTitleBar,
  RemoteCursorIcon,
  COMPOSITION_TREE_CLASSES,
  Stack,
  TilePreviewOverlay,
  TileTree,
  TileZoneDebug,
  subscribeVantage,
  useNotice,
} from "@manifold/plugin/ui";
import {
  ElementOutlet,
  ContainerOverlayOutlet,
  ContainerRenderer,
  REMOTE_CURSOR_FALLBACK_COLOR,
  TerminalRenderer,
  carriesItem,
  carryGhosts,
  clampCursorFraction,
  createPlacementLookup,
  createTileDropStore,
  cursorFraction,
  denialMessage,
  envelopeRef,
  firstLineLabel,
  remoteCursorSocketId,
  remoteTileCarries,
  sessionUrl,
  refDisplayLabel,
  useCarry,
  useItemDrop,
  useProjection,
  useRemoteCursors,
  useRemoteGestures,
  useTerminalFacet,
  useTileDrop,
  useContainerRoute,
  type ItemEnvelope,
  type ContainerRendererProps,
  type TileDropHost,
} from "@manifold/plugin/hooks";

/**
 * The composition discipline's renderer — `core.compositions`'s whole browser half. A canvas and a
 * composition are one container object told apart by `discipline`; this module draws the
 * `discipline: "composition"` half, a recursive flex tree over the scene doc's layout key, while
 * `core.canvas` draws the other.
 *
 * Two invariants shape the code. First, the tree structure — not the ratios — decides
 * React identity: a divider drag only rewrites `ratios`, so every leaf keeps its key
 * and its position in the element tree, and an xterm is never reparented (which would
 * destroy the terminal). Second, structural writes go through the server's doors so it can
 * enforce container discipline and the bubble lifecycle; only the high-frequency, purely
 * geometric ratio write goes straight into the doc.
 *
 * Nothing a leaf HOLDS is drawn here. A terminal, an embedded container and a note each
 * belong to a different plugin, and this one may not import any of them (REGISTRY.md §Foundation),
 * so every occupant arrives through the engine's projection registry
 * (`@manifold/plugin/hooks`) and every absent one paints the engine's named placeholder. What
 * this file owns is the tree, the gestures that land things in it, and the chrome each leaf
 * wears — the projection, not the projected.
 */

/**
 * The item kind a leaf's occupant IS, by ref form. A record over the ref union
 * rather than a chain of tests, so a new tileable form cannot be added without saying what
 * the placement algebra should call it.
 *
 * The values are `PlacementItem["kind"]` — a plain string — because the kind set is OPEN: a
 * note's leaf reports `text`, which is `core.notes`'s contributed element type rather than a
 * member of the closed floor table, and the algebra reads its traits from the composition
 * (ADR 0013 §12).
 */
const SOLO_ITEM_KINDS: Record<TileRef["kind"], PlacementItem["kind"]> = {
  terminal: "terminal",
  container: "canvas",
  text: "text",
  panel: "panel",
  // Unreachable in practice — a composition never legitimately holds a spacer, exactly as it
  // never holds a panel (issue #89's spacer is workspace-tree furniture) — but the record is
  // total over the ref union so a new tileable form cannot be added silently.
  spacer: "panel",
};

/**
 * What this composition holds when it holds exactly ONE thing, as the placement algebra reads
 * it — an occupancy map of one entry, or none.
 *
 * The ARITY half is `soloLeaf` in `@manifold/protocol`: "exactly one leaf, occupied", including
 * the edge that an EMPTY second leaf still ends it, because splitting is how someone declares a
 * container to be a composition. That walk used to be written out here and again in
 * `core.canvas`'s portal, two sibling plugins that may not import each other, each re-deriving
 * the same rule about the same wire record (issue #117). What is left here is the TRANSLATION —
 * from a ref form to the noun the algebra places by — which is this renderer's own business.
 */
function soloOccupancy(
  containerId: string,
  layout: TileLayout | null,
): ReadonlyMap<string, PlacementItem> {
  const solo = layout === null ? null : soloLeaf(layout);
  if (solo === null) return NO_SOLO_OCCUPANTS;
  const kind = SOLO_ITEM_KINDS[solo.ref.kind];
  return new Map<string, PlacementItem>([[containerId, { kind, containerId: containerId }]]);
}

const NO_SOLO_OCCUPANTS: ReadonlyMap<string, PlacementItem> = new Map();

/**
 * THE TILED RENDERER, as the projection registry mounts it: `ContainerRendererProps` and nothing of
 * its own. Everything route-shaped — where Shrink returns to, whose index row to refetch when
 * a structural write hardens a bubble, where to publish this view's "new terminal" verb —
 * comes from {@link useContainerRoute}, which is the shell's one published answer to "what is the
 * viewer looking at". A second prop bundle carrying the same facts would be a second answer.
 */
export function CompositionView({
  host,
  containerId,
  containers,
  presence,
  soloOccupants = NO_SOLO_OCCUPANTS,
  navigate,
}: ContainerRendererProps): ReactElement {
  const route = useContainerRoute();
  const {
    onCreateTerminalChange,
    originContainerId,
    refreshActiveContainer: onContainerChanged,
  } = route;
  /**
   * This container's row. The routed instance takes the record the shell already resolved; an
   * embedded one reads it out of the index it was handed. Null only for the frame between a
   * container being created and the next index response, which the titlebar's own default
   * covers.
   */
  const containerRecord =
    (route.activeContainer?.id === containerId ? route.activeContainer : null) ??
    containers.find((candidate) => candidate.id === containerId) ??
    null;
  const containerName = containerRecord?.name ?? null;
  /**
   * The composed vocabulary. A composition paints contributed elements in its leaves, projects
   * occupants belonging to other plugins into them, and asks the placement algebra about
   * contributed KINDS — every one of those answers is the roster's.
   */
  const projection = useProjection();
  const terminals = useTerminalFacet();
  /** Stable per roster change, which is exactly when a placement answer may move. */
  const roster = host.assembly.roster();
  const [client] = useState(
    () => new SessionClient({ url: sessionUrl(), containerId, token: host.token }),
  );
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [layout, setLayout] = useState<TileLayout | null>(null);
  const [machines, setMachines] = useState<readonly MachineSummary[] | null>(null);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  /** The per-frame channel to the preview overlay; only the overlay re-renders on it. */
  const [dropStore] = useState(createTileDropStore);
  /**
   * The element table's version. A note placed here is an ELEMENT of this room, so its
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
    // What the grab holds, classified here where the census is: a peer receives the
    // answer with every frame instead of asking its own index poll for it.
    resolveItem: (envelope: ItemEnvelope) => placementItemFor(envelopeRef(envelope), lookup),
    describe: (envelope: ItemEnvelope): string | null =>
      envelope.kind === "terminal"
        ? (client.terminals.get(envelope.terminalId)?.name ?? null)
        : null,
  });
  const { notify } = useNotice();

  /**
   * VIEW STATE, published (A2) — the composition route is the routed view while it is on screen,
   * so it owns the same one subscription the canvas renderer owns. Without it a viewer
   * inside a composition would publish nothing when it collapsed its sidebar: the store is
   * per device, and the socket that speaks for it is whichever route is mounted.
   */
  useEffect(() => {
    return subscribeVantage((vantage) => client.sendPresence({ vantage }));
  }, [client]);

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
        onContainerChanged();
      }
    };
    const offLayout = client.on("layout_changed", readLayoutAndRow);
    // Notes live in the element table, not the layout tree, so a placed note's text
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
  }, [client, onContainerChanged]);

  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    void client.connect().catch((reason: unknown) => {
      // Sticky: a composition that never connected is a degraded ref, not a passing
      // refusal, so the notice stays until it is dismissed or a later attempt supersedes it.
      notify(reason instanceof Error ? reason.message : "Could not connect to this composition", {
        lifetime: "sticky",
        key: "composition-connect",
      });
    });
    return () => client.close();
    // `notify` is the notice provider's own stable callback, so naming it here is honest
    // without arming a reconnect: this effect connects exactly once per client (the ref
    // guard), and a dependency that never moves can never trip that guard.
  }, [client, notify]);

  useEffect(() => {
    let cancelled = false;
    void host.client
      .machines()
      .then((fetched) => {
        if (!cancelled) setMachines(fetched);
      })
      .catch(() => {
        // Machine badges are decoration; the tiles render without them.
      });
    return () => {
      cancelled = true;
    };
  }, [host.client]);

  const shrink = useCallback((): void => {
    navigate(originContainerId === null ? "/" : `/p/${encodeURIComponent(originContainerId)}`);
  }, [navigate, originContainerId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to whatever shell has focus inside a tile — vim would be
      // unusable otherwise. It only shrinks the view from the view's own chrome.
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".terminal-frame") !== null) return;
      shrink();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shrink]);

  /**
   * The machine a terminal in a composition is running on, straight off the inventory. The dot's colour
   * rides `MachineSummary.color` — derived server-side over the shared identity palette — so
   * every viewer paints the same dot and no client re-implements the hash. An id absent from
   * the fetched list paints no badge, which is the honest answer rather than a synthesized
   * "unknown machine".
   */
  const machineFor = useCallback(
    (terminalId: string): MachineSummary | null => {
      const terminal = client.terminals.get(terminalId);
      if (terminal === undefined) return null;
      return machines?.find((candidate) => candidate.id === terminal.machineId) ?? null;
    },
    [client, machines],
  );

  /**
   * A container tile's bar names its ref. The list the sidebar already fetched IS the
   * index of containers, so an embedded container's name costs no extra request; a container
   * created since the last refetch falls back to the bar's own default.
   */
  const containerNameFor = useCallback(
    (embeddedContainerId: string): string | null =>
      containers.find((candidate) => candidate.id === embeddedContainerId)?.name ?? null,
    [containers],
  );
  /** Accessible names must identify the object even before its row is known. */
  const containerLabelFor = useCallback(
    (embeddedContainerId: string): string =>
      containerNameFor(embeddedContainerId) ?? embeddedContainerId,
    [containerNameFor],
  );
  /**
   * WHOSE renderer draws an embedded container: its discipline decides, and the index is
   * the only party that knows it.
   *
   * An id the index has not answered yet resolves to NOTHING rather than to `canvas`
   * (#110). The discipline roster is open, so guessing is no longer a harmless shortcut
   * between the only two possibilities — it is the silent downgrade #86's ratification
   * forbade, and it would paint a stranger's container with a canvas renderer that cannot
   * read it. The empty string is a layout key nothing can register (a discipline id must
   * match {@link DISCIPLINE_ID_PATTERN}), so `ContainerRenderer` answers with the
   * engine-owned placeholder in its `unknown` state, which is the honest reading of "the
   * index has not told me yet".
   */
  const disciplineFor = useCallback(
    (embeddedContainerId: string): string =>
      containers.find((candidate) => candidate.id === embeddedContainerId)?.discipline ?? "",
    [containers],
  );

  /**
   * The one failure path. Every notice in the application lands in the notice layer now,
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
      void host.client
        .renameContainer(containerId, name)
        .then(onContainerChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not rename this composition", "rename-view"),
        );
    },
    [failed, host.client, onContainerChanged, containerId],
  );

  /**
   * Deleting the container everyone is inside: the viewer leaves the way Shrink
   * leaves, and the sidebar refetch drops the row. Guarded by the ref alone: the
   * click deletes on the spot, and a second call would 404.
   */
  const removeView = useCallback((): void => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    void host.client
      .deleteContainer(containerId)
      .then(() => {
        shrink();
        onContainerChanged();
      })
      .catch((reason: unknown) => {
        deletingRef.current = false;
        failed(reason, "Could not delete this composition", "delete-view");
      });
  }, [failed, host.client, onContainerChanged, containerId, shrink]);

  /**
   * Titlebar rename of a terminal in a composition, through the ACTION DOOR; the room broadcast updates
   * every viewer. A denial is data — the door's own sentence — so a disabled plugin or a
   * missing capability reads as a named notice rather than an HTTP status.
   */
  const renameTile = useCallback(
    (terminalId: string, name: string): void => {
      void client
        .action("core.terminals.rename", { terminalId, name })
        .then((outcome) => {
          if (!outcome.ok) notify(outcome.denial.message, { key: "rename-terminal" });
        })
        .catch((reason: unknown) =>
          failed(reason, "Could not rename this terminal", "rename-terminal"),
        );
    },
    [client, failed, notify],
  );

  /**
   * Kill: removing a terminal's last leaf IS its destruction — there is no pool to fall
   * back into, so the server reaps the shell with the placement and deletes the
   * composition when this emptied it.
   */
  const closeTile = useCallback(
    (tileId: string): void => {
      void host.client
        .removeContainerTile(containerId, tileId)
        .then(onContainerChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not close this terminal", "close-terminal"),
        );
    },
    [failed, host.client, onContainerChanged, containerId],
  );

  /**
   * A CANVAS tile's minimize: the leaf goes away and the canvas itself is untouched — a
   * canvas is a shared object indexed in the sidebar, so removing its representation
   * from this composition is not ending it. Same endpoint as a terminal's park; the
   * server's park semantics only apply to a terminal, and a canvas ref has none.
   */
  const detachContainerTile = useCallback(
    (tileId: string): void => {
      void host.client
        .removeContainerTile(containerId, tileId)
        .then(onContainerChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not remove this canvas from the composition", "remove-canvas"),
        );
    },
    [failed, host.client, onContainerChanged, containerId],
  );

  /**
   * A CANVAS tile's close: the canvas is deleted for everyone, and the server's delete
   * prunes EVERY reference to it — this leaf included — before the row goes
   * (`deleteContainer` → `removeReferences`). No second removal call: chasing the leaf
   * afterwards always found it already gone and notified "Could not delete this canvas"
   * over a delete that had succeeded.
   */
  const deleteContainerTile = useCallback(
    (embeddedContainerId: string): void => {
      void host.client
        .deleteContainer(embeddedContainerId)
        .then(onContainerChanged)
        .catch((reason: unknown) =>
          failed(reason, "Could not delete this canvas", "delete-canvas"),
        );
    },
    [failed, host.client, onContainerChanged],
  );

  /**
   * A NOTE tile's close. Removal addresses the LEAF, and the server deletes the note
   * element with it, because a note's leaf is its only placement — there is nowhere else
   * for a note to be, so an orphaned element would be invisible garbage.
   */
  const removeNoteTile = useCallback(
    (tileId: string): void => {
      void host.client
        .removeContainerTile(containerId, tileId)
        .then(onContainerChanged)
        .catch((reason: unknown) => failed(reason, "Could not delete this note", "delete-note"));
    },
    [failed, host.client, onContainerChanged, containerId],
  );

  /**
   * The sidebar's Machines "+" inside a view. There is no canvas to author an element on,
   * so the open frame hands placement to the container and the SERVER writes the leaf —
   * the first empty one, else a split of the root. Placement is not on the terminal
   * record, so the tile that takes focus is read back out of the live layout: the doc
   * update carrying the leaf precedes the open confirmation on this same socket.
   */
  const createTerminal = useCallback(
    async (machine?: MachineSummary): Promise<void> => {
      if (client.epoch === "") {
        notify("Waiting for the composition connection", { key: "open-terminal" });
        return;
      }
      /*
        WHERE a new terminal is born is the terminal plugin's policy, not this renderer's:
        this device's memory for this container, else the composed default. Asking through the
        facet is also what makes the affordance honest — no facet means nobody owns terminals
        right now, and the open below would be refused anyway.
       */
      const target = machine ?? terminals?.defaultMachine(containerId, machines) ?? null;
      if (target !== null) terminals?.rememberMachine(containerId, target.id);
      try {
        const terminal = await client.openTerminal({
          elementId: crypto.randomUUID(),
          placement: "tile",
          cols: 80,
          rows: 24,
          ...(target === null ? {} : { machineId: target.id }),
        });
        const placed = tileIdForRef(client.layout(), {
          kind: "terminal",
          terminalId: terminal.id,
        });
        if (placed !== null) setFocusedTileId(placed);
      } catch (reason: unknown) {
        failed(reason, "Could not open a terminal in this composition", "open-terminal");
      }
    },
    [client, failed, machines, notify, containerId, terminals],
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
   * Composition rooms carry view-root FRACTIONS rather than pixels — see `cursorFraction`.
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
        containers,
        self: { containerId, discipline: "composition" },
        elements: client.elements,
        // A terminal's home composition rides on its terminal record, so this room can
        // answer for every terminal it holds without asking the server.
        terminalHomes: new Map(
          [...client.terminals.values()].map(
            (terminal) => [terminal.id, terminal.containerId] as const,
          ),
        ),
        // The index answers the arity question for every OTHER container (it is the
        // only party that can), and this room answers for ITSELF from its live layout —
        // its own answer wins, because the index's poll can lag a structural write.
        soloOccupants: (() => {
          const merged = new Map(soloOccupants);
          merged.delete(containerId);
          for (const [id, item] of soloOccupancy(containerId, client.layout()))
            merged.set(id, item);
          return merged;
        })(),
        /*
          A CONTRIBUTED element kind's placement traits live in its manifest, not in the closed
          floor table (ADR 0013 §12) — a note leaf reports `text`, so without the roster this
          preview would refuse drags the server accepts.
        */
        roster,
      }),
    /*
      `sceneRevision` is a KEY, not a closure read, and the exhaustive-deps rule says so out
      loud — leave it anyway: this room's terminal table and layout tree mutate in place, and
      both snapshots above (terminal homes, merged solo occupancy) are taken HERE. Drop this
      dependency and a preview answers from the tree as it stood at the last unrelated
      re-render, which is exactly the disagreement with the server this lookup exists to
      prevent.
    */
    [client, containers, containerId, roster, sceneRevision, soloOccupants],
  );

  const drop = useItemDrop({
    lookup,
    place: (ref, destination) => client.place(ref, destination),
    notify,
    // A landed placement may have hardened a bubble (a second leaf claims the container),
    // so the sidebar row is refetched with the drop.
    onPlaced: () => onContainerChanged(),
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
        .place({ kind: "tile", containerId: containerId, tileId }, { kind: "unplaced" })
        .then((outcome) => {
          if (!outcome.ok) throw new Error(denialMessage(outcome.denial, lookup));
          onContainerChanged();
        })
        .catch((reason: unknown) =>
          failed(reason, "Could not remove this terminal from the composition", "unplace-terminal"),
        );
    },
    [client, failed, lookup, onContainerChanged, containerId],
  );

  /**
   * What a tile ref is CALLED here, through the one shared switch: this route supplies the
   * documents (its terminals, the container index, its own text elements) plus the roster that
   * words a nameless one, and supplies no species logic of its own, so a canvas portal showing
   * the same composition captions the same drag with the same words.
   */
  const refLabel = useCallback(
    (ref: TileRef | null): string | null =>
      refDisplayLabel(ref, {
        terminalName: (terminalId) => client.terminals.get(terminalId)?.name ?? null,
        containerName: containerNameFor,
        textElement: (elementId) => {
          const element = client.elements.get(elementId);
          /*
            No `type === "text"` guard: the payload answers null for an element that bears no
            text (ADR 0013 §16), which is the same question asked without this renderer holding
            another plugin's wire type — and the type it DOES report is what words the label.
          */
          return element === undefined
            ? null
            : { type: element.type, text: elementString(element, "text") ?? "" };
        },
        roster,
      }),
    [client, containerNameFor, roster],
  );

  /** The slot chip names what is in flight, the way a carry ghost does. */
  const carryLabel = useCallback(
    (envelope: ItemEnvelope): string | null => {
      switch (envelope.kind) {
        case "terminal":
          return client.terminals.get(envelope.terminalId)?.name ?? null;
        case "tile":
          return envelope.containerId === containerId
            ? refLabel(layout?.[envelope.tileId]?.ref ?? null)
            : null;
        case "canvas":
        case "composition":
          return containerNameFor(envelope.containerId);
        case "element":
          return null;
        /*
          The palette says what it is holding better than this composition could: its own
          tool title is the word the reader just dragged out of the bar, and re-deriving a
          noun from the shape here would be a second name for one thing. The chip falls back
          to the label vocabulary's own "structure" (`ITEM_NOUNS`), like any unnamed carry.
        */
        case "structure":
          return null;
        default: {
          const exhaustive: never = envelope;
          return exhaustive;
        }
      }
    },
    [client, layout, containerId, containerNameFor, refLabel],
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
      containerId: containerId,
      portal: null,
      dividerPx: COMPOSITION_TREE_CLASSES.dividerPx,
      assess: drop.assess,
      describeCarry: carryLabel,
    }),
    [carryLabel, drop.assess, layout, containerId],
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
    dropStore.setRemote(containerId, remoteTileCarries(remoteGestures.values()));
  }, [dropStore, containerId, remoteGestures]);

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
        { kind: "tile", containerId: containerId, tileId },
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
   * to the pipeline, so no handler below authors a rule of its own. The one thing they
   * DO decide is whether this view claims the gesture at all, which is not a placement
   * rule but an answer to somebody else's: see the note inside `onDragOver`.
   */
  const areaDropProps = {
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer)) return;
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
      // This browser's own verdict comes from the one pipeline instance the overlay paints
      // from, so the cursor and the preview can never disagree about legality.
      const state = tileDrop.aimAt(event.clientX, event.clientY);
      /*
        A DROP TARGET CLAIMS A POINT ONLY IF IT CAN TAKE WHAT IS OVER IT.

        This used to claim every point it was handed and explain the refusal afterwards, on
        the argument that keeping the gesture is what lets the overlay paint the declared
        RULE instead of a bare no-drop cursor. The paint costs nothing here — the cue is
        drawn from the store above, which every frame updates whatever the answer — while
        the CLAIM costs everything behind it: `preventDefault` IS the claim token in this
        tree (the workspace's own listeners read `defaultPrevented` to mean "something
        inside took this point"), and `stopPropagation` does not even let them look. So a
        composition that swallowed a carry it was going to refuse denied every weaker
        claimant the chance to accept it — which is exactly how a palette structure aimed
        past a composition into the workspace tree behind it landed nowhere at all.

        Not a check on what KIND of thing is carried, deliberately: the rule is about
        denials in general. A terminal this composition refuses must fall through for the
        same reason a structure does, and a species test here would be the second door.
      */
      if (state === null || state.assessment?.denial != null) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
      clearDrop();
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer)) return;
      /*
        ONE RELEASE POLICY, AND IT IS THE PAINTED AIM (audit 1.3).

        This used to re-resolve from the drop's own pointer on the argument that reading the
        painted state races the render that drew it. Two answers to "is the paint
        authoritative at release?" is one too many, and this is the one that goes:

        - A preview is a PROMISE. Re-resolving commits an answer computed at a moment the
          eye was never shown, which is the one outcome a live preview exists to rule out.
        - The painted aim is the WIRE aim (`store.aim` is the single producer of both), so
          committing it is committing what every collaborator watched. A second resolution
          lands a placement nobody — including the dragger — ever saw.
        - It is the only policy BOTH renderers can state. A canvas transport does not own
          the portal's pipeline: one instance per host is the rule, because the memo is the
          hysteresis state. "Re-resolve on both" would mean reaching into a child's
          resolver, i.e. exactly the second machine that rule exists to forbid.

        The race is not real: `dragover` writes the pointer synchronously and React flushes
        the overlay's publish before the next discrete event, so the aim read here is the
        one the last frame painted. The verdict is taken BEFORE `carry.end`, which empties
        the register `assess` judges from — the same ordering the canvas pane documents.
      */
      const aim = dropStore.get().aim;
      const verdict = aim === null ? null : drop.assess(aim.destination);
      const at = bodyFraction(event.clientX, event.clientY);
      // The ghost is retired before the write: the payload is in the transfer, so
      // ending the carry here cannot cost the drop its envelope.
      carry.end(at ?? undefined);
      setCarriedTileId(null);
      clearDrop();
      /*
        The same rule the `dragover` above answers to: released between zones (a divider,
        the carry's own leaf) or refused, this view takes no mutation AND no claim, so the
        release keeps bubbling to whatever weaker claimant is behind it. Nothing behind it
        either, and it is the documented escape — abort with no mutation and no notice.
      */
      if (aim === null || verdict?.denial != null) return;
      event.preventDefault();
      event.stopPropagation();
      drop.commit(event.dataTransfer, aim.destination);
    },
  };

  /**
   * A leaf's occupant. One arm per tileable species, and the switch is exhaustive on
   * purpose: the protocol cannot grow a fourth ref without this frame growing a way
   * to draw it.
   */
  const renderRef = (node: Tile, ref: TileRef | null): ReactNode => {
    // A spacer is inert workspace furniture (issue #89) — a composition never legitimately
    // holds one, any more than it holds a panel, but unlike a stray panel it carries no
    // capability worth naming: it reads exactly like the empty tile it is functionally equal
    // to, and drops a terminal, a canvas or a note into it exactly the same way.
    if (ref === null || ref.kind === "spacer") {
      return (
        <Cover className="composition-empty">
          <Stack gap="0.5rem" align="center">
            <span className="composition-empty-glyph" aria-hidden="true">
              <ItemIcon kind="composition" size={22} />
            </span>
            <span>Drop a terminal, a canvas or a note here</span>
          </Stack>
        </Cover>
      );
    }
    switch (ref.kind) {
      case "terminal":
        return (
          <TerminalRenderer
            key={`${node.id}:${ref.terminalId}`}
            client={client}
            terminalId={ref.terminalId}
            elementId={node.id}
            active={focusedTileId === node.id}
            panelHighlighted={false}
            machine={machineFor(ref.terminalId)}
            // Minimize takes the terminal OUT of the composition (it lives on, unplaced);
            // close ends it. There is no expand: a terminal inside a composition is
            // already where it lives, and the composition's own bar is one row up.
            onPark={() => unplaceTile(node.id)}
            onClose={() => closeTile(node.id)}
            onRenameTitle={(name) => renameTile(ref.terminalId, name)}
            renameAction="core.terminals.rename"
          />
        );
      case "container":
        return (
          /*
            A canvas tile wears the same bar as every other placed object. Maximize is the
            load-bearing control: an embedded canvas is a CANVAS — its interior belongs to
            React Flow, panning and all — so the titlebar is the only door INTO the canvas
            from here. Minimize drops just this representation; close deletes the canvas
            for everyone, on the click.

            The bar sits ABOVE the canvas rather than over it, so nothing about the
            embedded canvas's own pointer handling changes.
          */
          <div className="composition-tile">
            <NodeTitleBar
              className="composition-tile__bar"
              icon={<ItemIcon kind="canvas" size={13} />}
              title={containerNameFor(ref.containerId)}
              defaultTitle={itemNoun("canvas", roster)}
              onMinimize={() => detachContainerTile(node.id)}
              minimizeLabel={`Remove canvas ${containerLabelFor(ref.containerId)} from this composition`}
              minimizeTooltip="Remove this canvas from the composition (the canvas keeps existing)"
              onMaximize={() => navigate(`/p/${encodeURIComponent(ref.containerId)}`)}
              maximizeLabel={`Open canvas ${containerLabelFor(ref.containerId)}`}
              maximizeTooltip="Open this canvas"
              onClose={() => deleteContainerTile(ref.containerId)}
              closeLabel={`Delete canvas ${containerLabelFor(ref.containerId)}`}
              closeTooltip="Delete this canvas for everyone"
            />
            <div className="composition-tile__body">
              {/*
                PROJECTED, not imported: the leaf holds a container belonging to whichever
                plugin renders that container's discipline, and this renderer may not name it
                (A4 — resolve the reference, open a pipe, project it). The index answers which
                discipline; an id it has not answered yet, or one whose discipline nothing in
                this build declares, reads as the engine's named placeholder rather than as a
                guess (#110).
              */}
              <ContainerRenderer
                key={ref.containerId}
                layout={disciplineFor(ref.containerId)}
                host={host}
                containerId={ref.containerId}
                depth={2}
                navigate={navigate}
                presence={presence}
                // The embedded renderer answers the algebra from the same container index
                // this composition was handed; without it its own previews would be blind.
                containers={containers}
              />
            </div>
          </div>
        );
      case "text": {
        // A note has no identity outside the container holding it, so the element is
        // always in THIS room's document. It is missing only for the frame between a
        // placement landing in the layout and the element arriving with it.
        const element = client.elements.get(ref.elementId);
        const text = element === undefined ? "" : (elementString(element, "text") ?? "");
        /*
          The occupant names ITSELF: its declared element type is what the mark and the
          fallback noun are looked up with, so a leaf holding some other plugin's text-bearing
          element wears that plugin's word instead of this renderer's guess. The ref form
          (`text`) is only an address, and it is the best guess available for the one frame
          where the element has not arrived yet.
        */
        const kind = element?.type ?? "text";
        return (
          /*
            A note tile borrows the canvas tile's frame — `.composition-tile` is the bar/body
            rhythm every embedded object wears — and edits the SAME `Y.Text` it would edit
            on a canvas, through the room this composition is joined to.
          */
          <div className="composition-tile">
            <NodeTitleBar
              className="composition-tile__bar"
              icon={<ItemIcon kind={kind} size={13} />}
              title={firstLineLabel(text)}
              defaultTitle={itemNoun(kind, roster)}
              // Close, not minimize: a note's leaf is its ONLY placement, so the server
              // deletes the note element together with the leaf. There is no "remove the
              // representation" for an object that exists nowhere else.
              onClose={() => removeNoteTile(node.id)}
              closeLabel={`Delete ${itemNoun(kind, roster)}`}
              closeTooltip={`Delete this ${itemNoun(kind, roster)}`}
            />
            <div className="composition-tile__body">
              <ElementOutlet
                // The occupant's OWN type, not the ref form: a leaf addressed as `text` is
                // rendered by whichever plugin declared the element actually sitting in it.
                type={kind}
                elementId={ref.elementId}
                data={element === undefined ? {} : elementPayload(element)}
                doc={client}
                editingElementId={editingNoteId}
                onBeginEditing={setEditingNoteId}
                onEndEditing={() => setEditingNoteId(null)}
                // The element IS the leaf's occupant: emptying the note must not delete
                // it, or the leaf would be left with nothing to render.
                removeWhenEmpty={false}
              />
            </div>
          </div>
        );
      }
      case "panel": {
        /*
          Panels are leaves of a PRINCIPAL's workspace layout, not of a container's document, so
          this renderer never legitimately draws one — the shell does, through its panel
          outlet. The engine's own placeholder keeps a stray leaf visible and nameable
          instead of blanking the tile, and carries the `data-plugin-state` every other
          inert contribution carries.
        */
        const Placeholder = projection.Placeholder;
        return <Placeholder name={ref.panelId} state="unknown" />;
      }
      default: {
        const exhaustive: never = ref;
        return exhaustive;
      }
    }
  };

  const renderLeaf = (node: Tile): ReactNode => (
    <div
      className={`composition-leaf${focusedTileId === node.id ? " is-focused" : ""}${
        carriedTileId === node.id ? " is-carried" : ""
      }`}
      onPointerDownCapture={() => setFocusedTileId(node.id)}
    >
      {renderRef(node, node.ref)}
      {node.ref === null ? null : (
        /*
          The grip is this leaf's chrome-as-handle. A terminal tile's own titlebar
          cannot be it — xterm needs the bar for rename and the frame swallows
          pointerdown — so every species wears the same corner handle the portal's
          tiles wear on a canvas, and the gesture behind it is the same carry.
        */
        <div
          className="composition-leaf__grip"
          title="Drag to move this tile — onto a canvas to pull it out"
          {...gripProps(node.id, refLabel(node.ref))}
        >
          <ControlIcon kind="grip" size={12} />
        </div>
      )}
    </div>
  );

  const body =
    layout === null ? (
      <Cover className="composition-placeholder">
        {status === "open" ? "Preparing this view…" : "Connecting to this view…"}
      </Cover>
    ) : (
      /*
        THE tile tree — the same component a container portal draws on a canvas. Here it
        is always interactive: this route is an occupant socket by construction, so a
        divider drag writes the ratios straight into the doc.
      */
      <TileTree
        layout={layout}
        classes={COMPOSITION_TREE_CLASSES}
        interactive
        onRatios={setRatios}
        renderLeaf={renderLeaf}
      />
    );

  return (
    <div className="composition-view">
      <NodeTitleBar
        className="composition-header"
        icon={<ItemIcon kind="composition" size={15} />}
        title={containerName}
        defaultTitle={itemNoun("composition", roster)}
        onRenameTitle={rename}
        extraActions={<span className={`composition-status is-${status}`}>{status}</span>}
        onMaximize={shrink}
        maximizeControl="shrink"
        maximizeLabel="Shrink view"
        maximizeTooltip="Leave this view (Esc)"
        onClose={removeView}
        closeLabel={`Delete view ${containerName ?? containerId}`}
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
        className="composition-body"
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
          <TilePreviewOverlay drop={tileDrop} store={dropStore} refLabel={refLabel} />
          <TileZoneDebug
            layout={layout}
            areaRef={areaRef}
            dividerPx={COMPOSITION_TREE_CLASSES.dividerPx}
          />
        </div>
        <div className="composition-presence-layer" aria-hidden="true">
          {remoteCursors.cursors.map((cursor) => {
            const color = remoteCursors.colorFor(cursor);
            const fraction = clampCursorFraction(cursor);
            return (
              <div
                className="remote-cursor"
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
                  client.attendance.get(ghost.principalId)?.principal.color ??
                  REMOTE_CURSOR_FALLBACK_COLOR,
                left: `${String(ghost.x * 100)}%`,
                top: `${String(ghost.y * 100)}%`,
              }}
            >
              <span className="carry-ghost__glyph" aria-hidden="true">
                <ItemIcon kind={ghost.kind} size={12} />
              </span>
              <span className="carry-ghost__label">{ghost.label}</span>
            </div>
          ))}
        </div>
        {/*
          The presence CHROME, which is somebody else's: the roster island and the spotlight
          receipt belong to `core.presence` and reach every mounted ref through the same
          two overlay slots the canvas mounts. Remote cursors and carry ghosts above are this
          renderer's own paint, because only this renderer knows that a composition room measures in
          view-root fractions — the plane mechanism is the engine's, the projection is the
          view's, and the decoration is the presence plugin's.
        */}
        <ContainerOverlayOutlet
          slot="container-roster"
          client={client}
          containerId={containerId}
          host={host}
        />
        <ContainerOverlayOutlet
          slot="container-spotlight"
          client={client}
          containerId={containerId}
          host={host}
        />
      </div>
    </div>
  );
}
