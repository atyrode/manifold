import { itemNoun, type HostServices } from "@manifold/plugin";
import {
  elementString,
  elementPayload,
  locationPathContains,
  soloLeaf,
  type TileLayout,
  type Tile,
  type TileRef,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Cover,
  ItemIcon,
  NodeTitleBar,
  PORTAL_TREE_CLASSES,
  Stack,
  TilePreviewOverlay,
  TileTree,
  TileZoneDebug,
  setVantage,
  currentVantage,
  useTileDeparture,
  type TilePreviewOverlayProps,
} from "@manifold/plugin/ui";
import type { TitlebarDragProps } from "@manifold/plugin/ui";
import {
  TerminalRenderer,
  ElementOutlet,
  ProjectionScopeProvider,
  TitlebarOutlet,
  extendProjectionScope,
  publishLocation,
  useProjectionScope,
  usePublishLocation,
  type ProjectionScope,
  countRender,
  remoteTileCarries,
  refDisplayLabel,
  useRemoteGestures,
  useTileDrop,
  type ItemEnvelope,
  type TileDropHost,
} from "@manifold/plugin/hooks";
import {
  MIN_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  useCanvas,
  useCanvasGestures,
} from "./terminal-element.tsx";
import {
  createPortalSocketSwitch,
  type ChannelRole,
  type PortalSlot,
  type PortalSocketSwitch,
} from "./portal-engagement.ts";

/**
 * The canvas face of a composition. A view and a container are one object, so a
 * container sitting inside a canvas is a plain scene element (`type: "portal"`)
 * that renders as a live portal: the container's own tiles, its occupants, and a
 * double-click that navigates into it.
 *
 * A portal has two states, and the difference between them is a socket discipline
 * rather than a mode switch anyone has to learn:
 *
 *   WATCHING (resting) — a spectator socket. The tiles are live pixels, but nothing
 *     in them is writable, the container's occupant list does not include this
 *     browser, and a transient view is free to dissolve while the portal watches.
 *   ENGAGED — an occupant socket to the same container. The tiles are ordinary
 *     terminals: typing, selection, resize and focus presence all flow, the roster
 *     (and therefore every avatar strip) shows this principal, and the bubble rule
 *     correctly refuses to pop a view somebody is working in.
 *
 * ENGAGEMENT RULE — one gesture each way, no timers:
 *   engage    a plain CLICK on a tile. Click, not pointerdown: a press that becomes a
 *             drag has to extract the tile, so escalating on the press would make
 *             every decompose drag an occupancy claim.
 *   disengage a POINTERDOWN anywhere outside this portal (document capture). Same rule
 *             a window manager uses for focus, so it needs no teaching, and it means
 *             an abandoned portal drops back to spectator instead of pinning a bubble.
 */

/**
 * React Flow drag handle for a portal node: the name strip only, so the preview
 * body stays free for the tile drags that decompose a composition.
 */
export const PORTAL_DRAG_HANDLE = ".portal__strip";

/**
 * A portal rendering its container's ONE terminal as itself (the arity rule). The class
 * is load-bearing beyond paint: it scopes the canvas's drag-handle selector, so only a
 * mono portal is moved by the terminal titlebar inside it — inside a multi-tile portal
 * that same titlebar belongs to a tile, whose drag extracts rather than moves.
 */
export const MONO_PORTAL_CLASS = "portal--mono";
export const MONO_PORTAL_CLASS_SELECTOR = `.${MONO_PORTAL_CLASS}`;

/**
 * Resize is canvas-item chrome, not terminal chrome: a portal's frame border is a
 * grab zone exactly as a terminal's is (same 8px edges, same 14px corners, same
 * transparent controls), so the two species read as one. The floor is a portal's,
 * not a shell's — a composition preview stays legible far below a usable 80×24.
 */
export const MIN_PORTAL_WIDTH = 240;
export const MIN_PORTAL_HEIGHT = 160;

/**
 * Container nesting renders live to depth 2 — the routed canvas is depth 1, so a
 * portal on it shows its container's tiles. Deeper portals render as cards: a
 * live chain would open a room socket per level.
 */
export const MAX_LIVE_DEPTH = 2;

/** Container names live in the container's row, not its room, so the portal reads its own. */
function useContainerName(host: HostServices, containerId: string): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (containerId === "") return;
    let cancelled = false;
    void host.client
      .getContainer(containerId)
      .then((container) => {
        if (!cancelled) setName(container.name);
      })
      .catch((reason: unknown) => {
        // DELIBERATELY console-only, unlike every other failure in this app: nobody asked
        // for this fetch, the portal already reads its fallback label, and a canvas full of
        // portals would raise one notice per portal on a single network blip.
        console.error("evt=portal_name_failed", reason);
      });
    return () => {
      cancelled = true;
    };
  }, [host.client, containerId]);
  return name;
}

/**
 * One room socket per live portal, opened through the canvas's factory so the terminal
 * URL and identity stay in one place. Both callbacks are plain dependencies: the canvas
 * hands down stable actions while high-cadence motion has its own context, so the socket
 * can depend on those callbacks without sharing the motion subscription.
 *
 * Ownership follows the CONTAINER, never the role. Escalating to an occupant is a
 * gapless swap (`createPortalSocketSwitch`), and an effect keyed on the role would
 * defeat it by running its cleanup — closing the socket being painted — before the
 * replacement exists.
 */
function usePortalSocket(
  containerId: string,
  live: boolean,
  role: ChannelRole,
  open: (containerId: string, role: ChannelRole) => SessionClient,
  onFailure: (role: ChannelRole, reason: unknown) => void,
): PortalSlot<SessionClient> | null {
  const [slot, setSlot] = useState<PortalSlot<SessionClient> | null>(null);
  const switchRef = useRef<PortalSocketSwitch | null>(null);
  useEffect(() => {
    if (!live) return;
    const sockets = createPortalSocketSwitch(
      (nextRole) => open(containerId, nextRole),
      setSlot,
      onFailure,
    );
    switchRef.current = sockets;
    return () => {
      switchRef.current = null;
      sockets.dispose();
    };
  }, [containerId, live, onFailure, open]);
  // Ordered after the effect above within the same commit, so the first request always
  // finds a switch; afterwards this is the only thing a role flip has to do.
  useEffect(() => {
    switchRef.current?.request(role);
  }, [containerId, live, role]);
  return slot;
}

/**
 * The preview's tile tree, re-read whole on every layout change (the tree is
 * small and the SDK deliberately does not diff tile ids). Terminal changes are
 * re-read too: a leaf's machine badge and exited state come off the room's
 * terminal table, not the layout.
 */
function usePreviewLayout(client: SessionClient | null): TileLayout | null {
  // The tree is stored with its owning client so a torn-down socket's last tree
  // derives to null instead of being cleared by a synchronous effect setState.
  const [state, setState] = useState<{
    readonly owner: SessionClient;
    readonly layout: TileLayout | null;
  } | null>(null);
  useEffect(() => {
    if (client === null) return;
    const refresh = (): void => {
      setState({ owner: client, layout: client.layout() });
    };
    const offLayout = client.on("layout_changed", refresh);
    const offTerminals = client.on("terminals_changed", refresh);
    const offStatus = client.on("status", (status) => {
      if (status === "open") refresh();
    });
    refresh();
    return () => {
      offLayout();
      offTerminals();
      offStatus();
    };
  }, [client]);
  if (client === null) return null;
  if (state !== null && state.owner === client) return state.layout;
  // A socket promoted this commit has no cached tree yet, and its effect runs after
  // paint: reading through keeps an engagement from flashing the placeholder card.
  return client.layout();
}

interface PortalTerminalTileProps {
  readonly client: SessionClient;
  readonly tileId: string;
  readonly terminalId: string;
  /** True once the portal paints from an occupant socket: this terminal is real. */
  readonly interactive: boolean;
  /** True for the engaged tile — the one holding the keyboard. */
  readonly active: boolean;
  readonly onEngage: (tileId: string) => void;
  /**
   * The ARITY rule. A composition holding exactly this one terminal is not "a
   * composition containing a terminal" to anybody looking at it — it IS the terminal.
   * So the portal drops its own name strip and the terminal's titlebar becomes the
   * node's chrome, carrying the portal-level verbs: minimize puts the representation
   * away, close deletes the composition (which reaps the shell), maximize walks into it.
   */
  readonly mono: PortalMonoChrome | null;
  readonly projectionScope: ProjectionScope | null;
  readonly dragProps: TitlebarDragProps;
}

export interface PortalMonoChrome {
  readonly onPark: () => void;
  readonly onClose: () => void;
  readonly onExpand: () => void;
  readonly onRenameTitle: (name: string) => void;
}

function PortalTerminalTile({
  client,
  tileId,
  terminalId,
  interactive,
  active,
  onEngage,
  mono,
  projectionScope,
  dragProps,
}: PortalTerminalTileProps): React.ReactElement {
  const container = useCanvas();
  const machineId = client.terminals.get(terminalId)?.machineId;
  const publishHere = usePublishLocation(projectionScope);
  const engage = (event: React.SyntheticEvent<HTMLDivElement>): void => {
    publishHere();
    if (event.target instanceof Element && event.target.closest(".node-titlebar") !== null) return;
    onEngage(tileId);
  };
  return (
    <div
      className={interactive ? "portal__tile flow-portal__tile--live" : "portal__tile"}
      /*
        Engagement, in capture phase so the terminal frame's own pointer handling cannot
        swallow it, and on CLICK so a decompose drag never escalates a socket. In the
        engaged state the same handler moves the keyboard between tiles.
      */
      onClickCapture={engage}
      onFocusCapture={engage}
      onDoubleClick={(event) => {
        // A live terminal owns double-click (word selection), so it must not also reach
        // the portal root's navigate-into handler.
        if (interactive) event.stopPropagation();
      }}
    >
      {/*
        The terminal arrives through the COMPOSITION, not an import: `core.terminals` owns the
        viewer and this plugin may not name it. A miss (unregistered, or its plugin disabled)
        paints the engine's named placeholder in the same box.
      */}
      <TerminalRenderer
        client={client}
        terminalId={terminalId}
        elementId={tileId}
        projectionScope={projectionScope}
        frame={mono === null ? "tile" : "window"}
        titlebarDragProps={mono === null ? dragProps : { draggable: false }}
        active={active}
        panelHighlighted={false}
        machine={
          machineId === undefined
            ? null
            : (container.machines?.find((candidate) => candidate.id === machineId) ?? null)
        }
        chrome={interactive ? "full" : "preview"}
        {...(mono ?? {})}
        // The mono bar renames the TERMINAL, so its input names the action it fires.
        {...(mono === null ? {} : { renameAction: "core.terminals.rename" })}
      />
    </div>
  );
}

/**
 * A canvas placed inside a container renders as a name card, not a live canvas.
 * The plan's depth-2 contingency: the portal frame, the occupants and the join
 * gesture are what carry meaning, and a nested React Flow instance inside a
 * scaled preview costs a third room socket plus a second canvas renderer.
 */
function PortalContainerTile({
  containerId,
}: {
  readonly containerId: string;
}): React.ReactElement {
  const container = useCanvas();
  const name = useContainerName(container.host, containerId);
  return (
    <Cover className="portal__container-card">
      <Stack gap="0.3rem" align="center">
        <span className="portal__card-glyph" aria-hidden="true">
          <ItemIcon kind="canvas" size={22} />
        </span>
        <strong>{name ?? itemNoun("canvas", container.host.assembly.roster())}</strong>
        <button
          type="button"
          className="portal__enter"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => container.navigate(`/p/${encodeURIComponent(containerId)}`)}
        >
          Open
        </button>
      </Stack>
    </Cover>
  );
}

/**
 * The one terminal a composition holds, or null when it holds anything else.
 *
 * The ARITY half — "exactly one occupied leaf" — is `soloLeaf` in `@manifold/protocol`, a fact
 * about the layout record that the compositions renderer needs in the same words (issue #117).
 * What is left here is the SPECIES test: this renderer only stands in for a TERMINAL, because
 * a terminal is the one occupant whose own chrome can carry a portal's verbs.
 */
function soloTerminal(
  layout: TileLayout,
): { readonly tileId: string; readonly terminalId: string } | null {
  const solo = soloLeaf(layout);
  if (solo === null || solo.ref.kind !== "terminal") return null;
  return { tileId: solo.tileId, terminalId: solo.ref.terminalId };
}

interface PortalLeafProps {
  readonly client: SessionClient;
  readonly containerId: string;
  readonly node: Tile;
  readonly interactive: boolean;
  readonly engagedTileId: string | null;
  readonly onEngage: (tileId: string) => void;
  /** Non-null only for the ONE leaf of a mono container — see {@link soloTerminal}. */
  readonly mono: PortalMonoChrome | null;
}

/**
 * ONE leaf of a portal's tree. The recursion above it — splits, ratio dividers, panes —
 * is `TileTree`, the same component the fullscreen route draws, so this is the whole of
 * what a canvas portal still renders for itself: occupant projection and titlebar engagement.
 */
function PortalLeaf({
  client,
  containerId,
  node,
  interactive,
  engagedTileId,
  onEngage,
  mono,
}: PortalLeafProps): React.ReactElement {
  const container = useCanvas();
  const inheritedScope = useProjectionScope();
  const [editingId, setEditingId] = useState<string | null>(null);
  const scope = useMemo(() => {
    const placement = extendProjectionScope(inheritedScope, {
      kind: "tile",
      containerId,
      tileId: node.id,
    });
    const ref = node.ref;
    return ref === null || ref.kind === "spacer" || ref.kind === "panel"
      ? placement
      : extendProjectionScope(
          placement,
          ref.kind === "element" ? { kind: "element", containerId, elementId: ref.elementId } : ref,
        );
  }, [inheritedScope, containerId, node.id, node.ref]);
  const publishHere = usePublishLocation(scope);
  const dragProps: TitlebarDragProps = {
    draggable: true,
    onDragStart: (event) => {
      event.stopPropagation();
      container.carry.begin(
        { kind: "tile", containerId, tileId: node.id },
        {
          transfer: event.dataTransfer,
          label:
            node.ref?.kind === "terminal"
              ? (client.terminals.get(node.ref.terminalId)?.name ?? null)
              : null,
        },
      );
      container.trackCarry(event.clientX, event.clientY);
    },
    onDrag: (event) => {
      if (event.clientX !== 0 || event.clientY !== 0)
        container.trackCarry(event.clientX, event.clientY);
    },
    onDragEnd: () => container.carry.end(),
  };
  const ref = node.ref;
  // A spacer is inert workspace furniture (issue #89) — a portal preview never legitimately
  // holds one, any more than it holds a panel, but unlike a stray panel it carries no
  // capability worth naming: it reads exactly like the empty tile it is functionally equal to.
  if (ref === null || ref.kind === "spacer") {
    return <Cover className="portal__empty">empty tile</Cover>;
  }
  switch (ref.kind) {
    case "terminal":
      return (
        <PortalTerminalTile
          client={client}
          tileId={node.id}
          terminalId={ref.terminalId}
          interactive={interactive}
          active={interactive && engagedTileId === node.id}
          onEngage={onEngage}
          // Only a mono container hands this down; inside a multi-tile preview the
          // portal keeps its own bar and each tile keeps its preview chrome.
          mono={mono}
          projectionScope={scope}
          dragProps={dragProps}
        />
      );
    case "container":
      return (
        <ProjectionScopeProvider value={scope}>
          <div className="portal__occupant" onPointerDownCapture={publishHere}>
            <NodeTitleBar
              icon={<ItemIcon kind="canvas" size={13} />}
              title={container.containerName(ref.containerId)}
              defaultTitle="Container"
              middle={<TitlebarOutlet scope={scope} />}
              dragProps={dragProps}
            />
            <PortalContainerTile containerId={ref.containerId} />
          </div>
        </ProjectionScopeProvider>
      );
    case "element": {
      const element = client.elements.get(ref.elementId);
      const kind = element?.type ?? "element";
      return (
        <ProjectionScopeProvider value={scope}>
          <div
            className="portal__occupant"
            onPointerDownCapture={publishHere}
            onFocusCapture={() => {
              onEngage(node.id);
              publishHere();
            }}
            onClickCapture={() => {
              onEngage(node.id);
              publishHere();
            }}
          >
            <NodeTitleBar
              icon={<ItemIcon kind={kind} size={13} />}
              title={null}
              defaultTitle={itemNoun(kind, container.host.assembly.roster())}
              middle={<TitlebarOutlet scope={scope} />}
              dragProps={dragProps}
            />
            <div className="portal__occupant-body">
              <ElementOutlet
                type={kind}
                elementId={ref.elementId}
                data={element === undefined ? {} : elementPayload(element)}
                doc={client}
                editingElementId={interactive ? editingId : null}
                onBeginEditing={(id) => {
                  onEngage(node.id);
                  if (interactive) setEditingId(id);
                }}
                onEndEditing={() => setEditingId(null)}
                removeWhenEmpty={false}
              />
            </div>
          </div>
        </ProjectionScopeProvider>
      );
    }
    case "panel":
      /*
        A portal preview is a window onto a ROOM's tree, and no room's tree holds panels:
        panels are leaves of a principal's workspace layout, which the shell renders. A
        panel reaching here is therefore a layout written by something that had no business
        writing it, so this says exactly that instead of pretending to draw a panel.
      */
      return <div className="plugin-placeholder">{ref.panelId}</div>;
    default: {
      const exhaustiveRef: never = ref;
      return exhaustiveRef;
    }
  }
}

/** Live portal-room aims and source departures share the canvas-room motion feed. */
function PortalMotionOverlay({
  client,
  ...props
}: Omit<TilePreviewOverlayProps, "departure"> & {
  readonly client: SessionClient;
}): ReactNode {
  const overrides = useRemoteGestures(client);
  const canvasOverrides = useCanvasGestures();
  const containerId = props.drop.host.containerId;
  const store = props.store;
  const sources = useMemo(
    () => ({
      *[Symbol.iterator]() {
        yield* canvasOverrides.values();
        yield* overrides.values();
      },
    }),
    [canvasOverrides, overrides],
  );
  const departure = useTileDeparture(containerId, sources);
  useEffect(() => {
    store.setRemote(`portal:${containerId}`, remoteTileCarries(overrides.values()));
  }, [containerId, overrides, store]);
  useEffect(
    () => () => {
      store.setRemote(`portal:${containerId}`, new Map());
    },
    [containerId, store],
  );
  return <TilePreviewOverlay {...props} departure={departure} />;
}

function PortalNodeImpl({ id, data }: NodeProps): React.ReactElement {
  countRender("portal-node");
  const containerId = typeof data["containerId"] === "string" ? data["containerId"] : "";
  const container = useCanvas();
  const inheritedScope = useProjectionScope();
  const scope = useMemo(
    () =>
      containerId === ""
        ? null
        : extendProjectionScope(
            inheritedScope,
            { kind: "element", containerId: container.containerId, elementId: id },
            { kind: "container", containerId },
          ),
    [inheritedScope, container.containerId, id, containerId],
  );
  const publishHere = usePublishLocation(scope);
  const live = container.depth < MAX_LIVE_DEPTH && containerId !== "";
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The tile AREA: what drop geometry measures, so the strip is excluded by construction. */
  const areaRef = useRef<HTMLDivElement | null>(null);
  /**
   * The engagement remembers WHICH container it was made in: a portal that stops
   * being live or starts pointing elsewhere derives back to spectator instead of
   * being reset by an effect (the socket it engaged through is gone either way).
   */
  const [engagement, setEngagement] = useState<{
    readonly containerId: string;
    readonly tileId: string;
  } | null>(null);
  const engagedTileId =
    engagement !== null && engagement.containerId === containerId && live
      ? engagement.tileId
      : null;
  const engaged = engagedTileId !== null;
  const notify = container.notify;
  /**
   * Stable, because the socket effect now depends on it honestly: engaging is a direct
   * action, so its failure has to be visible — without this the viewer is left clicking
   * into a tile that will never accept a keystroke.
   */
  const onSocketFailure = useCallback(
    (failedRole: ChannelRole) => {
      setEngagement(null);
      notify(
        failedRole === "occupant"
          ? "Could not open this composition for editing."
          : "Could not open this assembly.",
      );
    },
    [notify],
  );
  const slot = usePortalSocket(
    containerId,
    live,
    engaged ? "occupant" : "spectator",
    container.openClient,
    onSocketFailure,
  );
  const client = slot?.client ?? null;
  /** Engagement is only real once the occupant socket is the one being painted. */
  const interactive = slot !== null && slot.role === "occupant";
  const layout = usePreviewLayout(client);
  const name = useContainerName(container.host, containerId);
  /** Stable per roster change: what to CALL a kind whose word is not the floor's. */
  const roster = container.host.assembly.roster();

  useEffect(() => {
    if (!engaged) return;
    const disengage = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      /*
       * The frame's resize controls live OUTSIDE `.portal` (the frame clips its
       * overflow, and a clipped control is a dead pointer target), but grabbing this
       * portal's own border is not a press "outside the portal": dropping occupancy
       * mid-resize would close the occupant socket under the pointer and hand a
       * transient view its excuse to pop. They are the portal's only other children
       * in the node wrapper, so the wrapper is the whole test.
       */
      if (
        target instanceof Element &&
        root.parentElement?.contains(target) === true &&
        target.closest(".react-flow__resize-control") !== null
      ) {
        return;
      }
      setEngagement(null);
      if (locationPathContains(currentVantage().locationPath, scope?.locationPath)) {
        setVantage({ focusedContainerId: null });
        publishLocation(inheritedScope?.locationPath ?? null);
      }
    };
    // Capture on the document: a press a canvas handler stops must still end
    // engagement, and only the document sees every press on the page.
    document.addEventListener("pointerdown", disengage, true);
    return () => {
      document.removeEventListener("pointerdown", disengage, true);
    };
  }, [engaged, inheritedScope, scope]);

  const engagementScope = useRef(scope);
  const enclosingScope = useRef(inheritedScope);
  useEffect(() => {
    engagementScope.current = scope;
    enclosingScope.current = inheritedScope;
  }, [scope, inheritedScope]);

  /**
   * Focus, published (A2). The ENGAGED portal is the one that speaks: every other portal on
   * the canvas would otherwise publish "nothing focused" and clobber it, so the transition —
   * and its cleanup, which covers disengaging, socket failure and unmount alike — is the
   * whole writer. Floor for now, `"until": "core.presence"`.
   */
  useEffect(() => {
    if (!engaged) return;
    setVantage({ focusedContainerId: containerId });
    return () => {
      if (
        locationPathContains(currentVantage().locationPath, engagementScope.current?.locationPath)
      ) {
        setVantage({ focusedContainerId: null });
        publishLocation(enclosingScope.current?.locationPath ?? null);
      }
    };
  }, [containerId, engaged]);

  const enter = (): void => {
    if (containerId === "") return;
    container.navigate(`/p/${encodeURIComponent(containerId)}`);
  };

  /**
   * The arity rule, resolved. A composition holding exactly one terminal renders AS
   * that terminal: no portal name strip, the terminal's own titlebar carrying this
   * element's verbs. Other occupants wear composition chrome at the same native scale.
   */
  const solo = client === null || layout === null ? null : soloTerminal(layout);
  const mono: PortalMonoChrome | null =
    solo === null
      ? null
      : {
          // Minimize: the representation leaves this canvas. Nothing else references the
          // terminal's home afterwards, which is exactly what "unplaced" means now.
          onPark: () => container.unplaceElement(id),
          // Close: the composition goes, and the shell it holds goes with it.
          onClose: () => container.onDeleteContainer(containerId, id),
          onExpand: enter,
          onRenameTitle: (name: string) => container.onRenameTerminal(solo.terminalId, name),
        };

  /**
   * The leaf half of the shared tree, bound to the socket being painted. Everything
   * above a leaf is `TileTree`; a portal contributes its leaves' chrome and nothing else.
   */
  const renderLeaf =
    (socket: SessionClient) =>
    (node: Tile): ReactNode => (
      <PortalLeaf
        client={socket}
        containerId={containerId}
        node={node}
        interactive={interactive}
        engagedTileId={engagedTileId}
        onEngage={(tileId) => setEngagement({ containerId, tileId })}
        // The arity rule reaches exactly ONE leaf: a mono container's single terminal
        // wears this element's verbs, and no leaf of a real composition ever does.
        mono={solo !== null && node.id === solo.tileId ? mono : null}
      />
    );

  /**
   * What a tile ref is CALLED here, through the one shared switch. The portal can answer all
   * three document questions — terminals and element text from its own room socket, container
   * names from the index the canvas holds — and carries the roster for the fourth, so the same
   * drag reads the same words here and on the fullscreen route instead of captioning terminals
   * only.
   */
  const occupantLabel = useCallback(
    (ref: TileRef | null): string | null =>
      refDisplayLabel(ref, {
        terminalName: (terminalId) => client?.terminals.get(terminalId)?.name ?? null,
        containerName: container.containerName,
        elementContent: (elementId) => {
          const element = client?.elements.get(elementId);
          /*
            No `type === "text"` guard: the payload answers null for an element bearing no text
            (ADR 0013 §16), which asks the same question without this renderer holding another
            plugin's wire type — and the type it DOES report is what words a nameless label.
          */
          return element === undefined
            ? null
            : { type: element.type, text: elementString(element, "text") ?? "" };
        },
        roster,
      }),
    [client, container.containerName, roster],
  );
  const carryLabel = useCallback(
    (envelope: ItemEnvelope): string | null => {
      switch (envelope.kind) {
        case "terminal":
          return client?.terminals.get(envelope.terminalId)?.name ?? null;
        case "tile":
          return envelope.containerId === containerId
            ? occupantLabel(layout?.[envelope.tileId]?.ref ?? null)
            : null;
        case "canvas":
        case "composition":
          return container.containerName(envelope.containerId);
        // See `canvas-view.tsx`: new structure is named by the vocabulary, not by a renderer.
        case "element":
        case "structure":
          return null;
        default: {
          const exhaustive: never = envelope;
          return exhaustive;
        }
      }
    },
    // `container`, not `container.containerName`: the name lookup is CALLED here, so the receiver is what this
    // callback actually closes over — and the context object hands out a fresh lookup with
    // every rebuild anyway, so the two move together.
    [client, containerId, layout, occupantLabel, container],
  );

  /**
   * The portal is the only place its own layout is visible — the canvas holds no
   * channel on that container — so aim resolution lives HERE, in ONE pipeline created
   * by this host and handed to the overlay: the overlay reads the canvas's pointer from
   * the shared store, resolves against this tree, and publishes the aim back both for
   * the canvas to commit at release and for this drag's carry frames to carry.
   */
  const dropHost = useMemo<TileDropHost>(
    () => ({
      areaRef,
      layout,
      containerId,
      portal: { containerId: container.containerId, elementId: id },
      dividerPx: PORTAL_TREE_CLASSES.dividerPx,
      assess: container.assessDrop,
      elementSeat: container.elementSeat,
      describeCarry: carryLabel,
    }),
    [
      carryLabel,
      containerId,
      id,
      layout,
      container.assessDrop,
      container.elementSeat,
      container.containerId,
    ],
  );
  const tileDrop = useTileDrop(dropHost);

  const overlay = (
    <>
      <PortalMotionOverlay
        client={client ?? container.client}
        drop={tileDrop}
        store={container.dropStore}
        refLabel={occupantLabel}
      />
      <TileZoneDebug layout={layout} areaRef={areaRef} dividerPx={PORTAL_TREE_CLASSES.dividerPx} />
    </>
  );

  const rootClass = [
    "portal",
    mono === null ? "" : MONO_PORTAL_CLASS,
    interactive ? "portal--engaged" : "",
    engaged && !interactive ? "portal--engaging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ProjectionScopeProvider value={scope}>
      {/*
        Desktop-window ergonomics, identical to a terminal node's: the frame border is
        the grab zone, so the pointer turns into a resize cursor on hover and no
        selection step is needed. Rendered as a SIBLING of `.portal` rather than a
        child because the portal frame clips its overflow (the preview must not spill),
        and a clipped control is a dead pointer target — the outer half of every edge
        band would be unreachable. The controls carry no paint (the cursor is the
        affordance) and commit once on resize end, matching the drag path.
      */}
      <NodeResizer
        nodeId={id}
        isVisible={container.tool === "select"}
        lineClassName="portal-resize-edge"
        handleClassName="portal-resize-corner"
        minWidth={mono === null ? MIN_PORTAL_WIDTH : MIN_TERMINAL_WIDTH}
        minHeight={mono === null ? MIN_PORTAL_HEIGHT : MIN_TERMINAL_HEIGHT}
        onResize={(_event, params) =>
          container.onResize(id, params.x, params.y, params.width, params.height)
        }
        onResizeEnd={(_event, params) =>
          container.onResizeEnd(id, params.x, params.y, params.width, params.height)
        }
      />
      <div
        className={rootClass}
        ref={rootRef}
        onDoubleClick={enter}
        onPointerDownCapture={publishHere}
        onFocusCapture={publishHere}
      >
        {mono !== null ? null : (
          <NodeTitleBar
            className="portal__strip"
            icon={<ItemIcon kind="composition" size={13} />}
            title={name}
            defaultTitle={itemNoun("composition", roster)}
            middle={<TitlebarOutlet scope={scope} />}
            dragProps={{ draggable: false }}
            onMinimize={() => container.unplaceElement(id)}
            minimizeLabel={`Put away composition ${name ?? containerId}`}
            minimizeTooltip="Remove this portal from the canvas (the composition keeps running)"
            onMaximize={enter}
            maximizeLabel={`Open composition ${name ?? containerId}`}
            maximizeTooltip="Open this composition"
            onClose={() => container.onDeleteContainer(containerId, id)}
            closeLabel={`Delete composition ${name ?? containerId}`}
            closeTooltip="Delete this composition for everyone"
          />
        )}
        <div className="portal__viewport">
          {client !== null ? (
            <div className="portal__preview">
              <div className="tile-area" ref={areaRef}>
                <TileTree
                  layout={layout ?? {}}
                  classes={PORTAL_TREE_CLASSES}
                  interactive={interactive}
                  onRatios={(splitId, ratios) => client.setTileRatios(splitId, ratios)}
                  renderLeaf={renderLeaf(client)}
                />
                {overlay}
              </div>
            </div>
          ) : (
            // The card form still hosts the overlay: a portal whose layout this canvas
            // cannot see keeps the canvas door, so drops on it stay targetable.
            <div className="tile-area" ref={areaRef}>
              <Cover className="portal__card">
                <Stack gap="0.3rem" align="center">
                  <span className="portal__card-glyph" aria-hidden="true">
                    <ItemIcon kind="composition" size={22} />
                  </span>
                  <span className="portal__card-hint">
                    {live ? "opening composition…" : "nested composition — open it to work inside"}
                  </span>
                </Stack>
              </Cover>
              {overlay}
            </div>
          )}
        </div>
      </div>
    </ProjectionScopeProvider>
  );
}

/**
 * Memoized for the same reason terminal nodes are: React Flow re-renders the node
 * being dragged once per pointermove, and a portal owns live terminals.
 */
export const PortalNode = memo(PortalNodeImpl);
