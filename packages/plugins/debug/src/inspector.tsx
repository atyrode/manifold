import { useProjection, type ProjectionRegistry, type WorkspaceOverlayProps } from "@manifold/plugin/hooks";
import { currentVantage, setVantage, useNotice, useVantage } from "@manifold/plugin/ui";
import {
  containmentPath,
  parseManifoldUri,
  type Principal,
  type ResolveResponse,
} from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { ancestryOf, subtreeOf, type Subtree } from "./dom.ts";
import {
  actionOwner,
  declarationAddress,
  declarationNoun,
  identify,
  type CompositionLookup,
  type Declaration,
  type Identity,
  type IdentityContext,
} from "./identity.ts";

/**
 * THE INSPECTOR: point at anything in the workspace and be told what it is, where it lives, who
 * owns it, what it can do and who is in it.
 *
 * This is the self-describing engine turned around to face the operator. The registries were
 * already complete — every plugin publishes a manifest, every mutating affordance carries
 * `data-action`, every addressable thing has exactly one `manifold://` form, every door is
 * traced — but reading any of it meant knowing where to look. Nothing here is new knowledge:
 * the chip is a JOIN of three things the page already holds (the DOM's own declarations, the
 * live assembly, and the resolve door) and it holds no state of its own about the workspace.
 *
 * READ-ONLY, and structurally so: it dispatches no action, opens no pipe, writes no document.
 * The only thing it writes anywhere is `vantage.tool`, which is how a mode becomes observable
 * (A2) — a collaborator can see that this principal is inspecting rather than working, and an
 * agent can read the mode back. Its two doors — copy, and navigating a breadcrumb hop — are the
 * clipboard and the host's own navigation.
 *
 * ARMED STATE IS THE VANTAGE, not a flag beside it. `vantage.tool === "inspect"` IS the mode, so
 * there is no second copy of "is this device inspecting" to drift (invariant 14), and the mode
 * survives this component re-rendering because the store outlives it.
 */

/** The tool id this mode publishes while armed. */
export const INSPECT_TOOL = "inspect";

/**
 * What was in the reader's hand before, so leaving the mode gives it back. In-memory and
 * lifetime-bounded by the mode itself: the CURRENT tool is the published value, and this is
 * only the undo of one write — a canvas whose `select` tool was displaced must not come back
 * holding nothing.
 */
let heldBeforeInspect: string | null = null;

/**
 * THE toggle, and the whole of what arms this mode. A function rather than a `setVantage` at
 * each caller for the reason `toggleArranging` is one: the mode has more than one entrance (the
 * F10 binding today, the card's own close control, Escape) and "read the flag, write its
 * negation" is the two-step that grows a second answer the moment it is written twice.
 */
export function toggleInspector(): void {
  const { tool } = currentVantage();
  if (tool === INSPECT_TOOL) {
    setVantage({ tool: heldBeforeInspect });
    return;
  }
  heldBeforeInspect = tool;
  setVantage({ tool: INSPECT_TOOL });
}

/** Where the pointer is, and what it is over. */
interface Aim {
  readonly x: number;
  readonly y: number;
  readonly element: Element;
}

/** A pinned reading: the identity, plus everything only a pin is allowed to go and ask for. */
interface Pin {
  readonly aim: Aim;
  readonly identity: Identity;
  readonly subtree: Subtree;
}

/** Which registered component paints the subject, when the projection registry knows. */
interface Painter {
  readonly plugin: string;
  readonly title: string;
  readonly component: string | null;
}

/**
 * WHO PAINTS THIS. Answered through the projection registry — the one read surface onto "who
 * did the composition register for this name" — and answered honestly rather than at all costs:
 * a sidebar row resolves to its section's registrant, a tile of the routed composition to
 * whoever draws that discipline, a canvas element node to whoever draws a canvas. A workspace
 * pane is drawn by the engine's own tile tree, and a door is not painted by anybody in
 * particular, so both answer null.
 */
function painterOf(subject: Declaration | null, registry: ProjectionRegistry): Painter | null {
  const registered =
    subject === null
      ? null
      : subject.kind === "section"
        ? registry.section(subject.id)
        : subject.kind === "tile" && subject.tree === "composition"
          ? registry.renderer("composition")
          : subject.kind === "element"
            ? registry.renderer("canvas")
            : null;
  if (registered === null) return null;
  /*
    A COMPONENT NAME ONLY WHEN IT IS ONE. A production bundle mangles function names, so
    `Component.name` comes back as `sV` there and as `MachinesSection` in dev — and a chip
    reading "painted by sV" is worse than one reading the owning plugin's title, because it
    looks like an answer. React's own convention is the test: a component name is capitalized.
  */
  const Component = registered.Component;
  const name = Component === null ? null : (Component.displayName ?? Component.name);
  return {
    plugin: registered.plugin,
    title: registered.title,
    component: name !== null && name !== undefined && /^[A-Z]/.test(name) ? name : null,
  };
}

/** One labelled row of the chip or the card. The chip is a definition list, because it is one. */
function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="inspector-row">
      <dt className="inspector-label">{label}</dt>
      <dd className="inspector-value">{children}</dd>
    </div>
  );
}

/**
 * The chip and the card share their identity block: noun, address, owner, painter. The card adds
 * to it rather than restating it, so what a reader learns by hovering never disagrees with what
 * they learn by pinning.
 */
function IdentityBlock({
  identity,
  host,
  painter,
  onCopy,
}: {
  readonly identity: Identity;
  readonly host: WorkspaceOverlayProps["host"];
  readonly painter: Painter | null;
  readonly onCopy: ((uri: string) => void) | null;
}): ReactElement {
  const roster = host.assembly.roster();
  const owner =
    identity.plugin === null
      ? null
      : (roster.find((entry) => entry.manifest.id === identity.plugin) ?? null);
  const noun = identity.subject === null ? "nothing" : declarationNoun(identity.subject, roster);
  return (
    <dl className="inspector-rows">
      <Row label="is">
        <strong className="inspector-noun">{noun}</strong>
        {identity.subject === null ? null : (
          <span className="inspector-declared">
            {identity.subject.attribute}=&quot;{identity.subject.id}&quot;
          </span>
        )}
      </Row>
      <Row label="at">
        {identity.uri === null ? (
          <span className="inspector-absent">not addressable</span>
        ) : (
          <>
            <code className="inspector-uri">{identity.uri}</code>
            {onCopy === null ? null : (
              <button
                type="button"
                className="inspector-copy"
                onClick={() => onCopy(identity.uri ?? "")}
              >
                Copy
              </button>
            )}
          </>
        )}
      </Row>
      <Row label="owner">
        {owner === null ? (
          <span className="inspector-absent">unowned</span>
        ) : (
          <>
            {owner.manifest.title} <span className="inspector-muted">{owner.manifest.id}</span>{" "}
            <span className="inspector-muted">v{owner.manifest.version}</span>
            {owner.enabled ? null : <span className="inspector-absent"> disabled</span>}
          </>
        )}
      </Row>
      <Row label="painted by">
        {painter === null ? (
          <span className="inspector-absent">the engine</span>
        ) : (
          <>
            {painter.component ?? painter.title}{" "}
            <span className="inspector-muted">{painter.plugin}</span>
          </>
        )}
      </Row>
    </dl>
  );
}

/**
 * THE PINNED CARD: the identity block, the containment path out, what is under this thing, every
 * door it reaches, and who is in it.
 *
 * The breadcrumb is TWO chains joined, and that is the honest shape rather than a compromise.
 * The DOM chain is what actually contains what on screen; `containmentPath` is the ADDRESS
 * chain the workspace itself walks for grants and events (`packages/protocol/src/uri.ts`). A hop
 * navigates when it has an address, through `host.navigate` — the one door for "put the viewer
 * at this address" — and is inert prose when it does not.
 */
function PinCard({
  pin,
  host,
  painter,
  resolved,
  occupants,
  onCopy,
  onClose,
}: {
  readonly pin: Pin;
  readonly host: WorkspaceOverlayProps["host"];
  readonly painter: Painter | null;
  readonly resolved: ResolveResponse | null;
  readonly occupants: readonly Principal[] | null;
  readonly onCopy: (uri: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const roster = host.assembly.roster();
  const address = pin.identity.uri === null ? null : containmentPath(pin.identity.uri);
  return (
    <section
      className="inspector-card"
      style={placedAt(pin.aim.x + 14, pin.aim.y + 16, CARD_BOX)}
      aria-label="Inspector"
    >
      <header className="inspector-card__bar">
        <span className="inspector-card__title">Inspector</span>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <IdentityBlock identity={pin.identity} host={host} painter={painter} onCopy={onCopy} />
      <dl className="inspector-rows">
        <Row label="resolves">
          {pin.identity.uri === null ? (
            <span className="inspector-absent">no address to resolve</span>
          ) : resolved === null ? (
            <span className="inspector-muted">asking the workspace…</span>
          ) : resolved.exists ? (
            <>
              yes <span className="inspector-muted">{resolved.title ?? "untitled"}</span>
            </>
          ) : (
            <span className="inspector-absent">the workspace holds no such node</span>
          )}
        </Row>
        <Row label="within">
          <span className="inspector-hops">
            {pin.identity.chain.map((hop, index) => (
              <Hop
                key={`${hop.attribute}:${hop.id}:${String(index)}`}
                hop={hop}
                routedContainerId={host.containerId}
                host={host}
              />
            ))}
          </span>
        </Row>
        {address === null ? null : (
          <Row label="containment">
            <span className="inspector-hops">
              {address.map((uri) => (
                <button
                  key={uri}
                  type="button"
                  className="inspector-hop"
                  onClick={() => host.navigate(uri)}
                >
                  {uri}
                </button>
              ))}
            </span>
          </Row>
        )}
        <Row label="holds">
          {String(pin.subtree.children)} declared{" "}
          {pin.subtree.children === 1 ? "thing" : "things"}
        </Row>
        <Row label="doors">
          {pin.subtree.doors.length === 0 ? (
            <span className="inspector-absent">none — nothing under here mutates</span>
          ) : (
            <span className="inspector-doors">
              {pin.subtree.doors.map((door) => (
                <code key={door} className="inspector-door">
                  {door}
                </code>
              ))}
            </span>
          )}
        </Row>
        <Row label="occupants">
          {occupants === null ? (
            <span className="inspector-absent">not a room</span>
          ) : occupants.length === 0 ? (
            <span className="inspector-muted">nobody here</span>
          ) : (
            <span className="inspector-occupants">
              {occupants.map((principal) => (
                <span key={principal.id} className="inspector-occupant">
                  <span
                    className="inspector-occupant__dot"
                    style={{ background: principal.color }}
                    aria-hidden="true"
                  />
                  {principal.name}
                </span>
              ))}
            </span>
          )}
        </Row>
      </dl>
      <p className="inspector-hint">
        {`Click anything to pin it here. ${String(roster.length)} plugins are assembled; Esc or F10 leaves.`}
      </p>
    </section>
  );
}

/**
 * One hop of the DOM chain: a navigable address, or the declaration as prose. Each hop is
 * addressed on its OWN terms through the same rule the subject is (`declarationAddress`) rather
 * than borrowing the subject's — a breadcrumb whose hops all navigated to the same place would
 * be chrome pretending to be a path.
 */
function Hop({
  hop,
  routedContainerId,
  host,
}: {
  readonly hop: Declaration;
  readonly routedContainerId: string | null;
  readonly host: WorkspaceOverlayProps["host"];
}): ReactElement {
  const label = `${hop.kind} ${hop.id}`;
  const uri = declarationAddress(hop, routedContainerId);
  if (uri === null) return <span className="inspector-hop is-inert">{label}</span>;
  return (
    <button type="button" className="inspector-hop" onClick={() => host.navigate(uri)}>
      {label}
    </button>
  );
}

/**
 * The inspector, mounted in the workspace's `inspector` overlay slot.
 *
 * WHY A WORKSPACE OVERLAY and not a container one: the chip has to be able to name the sidebar
 * row under the pointer, and a container's overlay slot cannot paint outside its own renderer.
 * It also must not sit in a subtree the sidebar's collapse can unmount, which is the same reason
 * the notice layer is mounted where it is.
 *
 * Nothing is listened to while the mode is off — no pointer handler, no keydown, no paint — so a
 * workspace with the inspector idle costs exactly one React component that renders null.
 */
export function Inspector({ host }: WorkspaceOverlayProps): ReactElement | null {
  const armed = useVantage().tool === INSPECT_TOOL;
  const registry = useProjection();
  const notice = useNotice();
  const [aim, setAim] = useState<Aim | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [resolved, setResolved] = useState<ResolveResponse | null>(null);
  const [occupants, setOccupants] = useState<readonly Principal[] | null>(null);

  /**
   * The live composition, as the pure layer asks it. Keyed on the host ref, which is itself
   * rebuilt whenever the assembly moves — so the lookups can never answer for a roster that has
   * been toggled since, and the two pointer effects below get a stable dependency instead of a
   * fresh object per render.
   */
  const context = useMemo<IdentityContext>(() => {
    const composition: CompositionLookup = {
      sectionOwner: (id) => host.assembly.sections.find((row) => row.id === id)?.plugin ?? null,
      /*
        A panel id is `<pluginId>.<panelId>`, and the owner is read off the ROSTER rather than
        split off the string: splitting would invent a plugin for any id with a dot in it.
      */
      panelOwner: (id) =>
        host.assembly
          .roster()
          .find((entry) =>
            entry.manifest.contributes.panels.some(
              (panel) => `${entry.manifest.id}.${panel.id}` === id,
            ),
          )?.manifest.id ?? null,
      actionOwner: (name) =>
        actionOwner(
          name,
          host.assembly.roster().map((entry) => entry.manifest.id),
        ),
    };
    return { routedContainerId: host.containerId, composition };
  }, [host]);

  /**
   * THE READING under the pointer right now, and the pinned one when there is one. Computed in
   * render rather than stored: it is a pure function of the aim and the composition, and a copy
   * kept in state would be a second answer to "what is this" that could disagree with the chip
   * painting beside it.
   */
  const hovered = !armed || aim === null ? null : identify(ancestryOf(aim.element), context);
  const reading = pin?.identity ?? hovered;

  /**
   * The same reading, for the KEY handler. A listener re-registered on every pointer frame would
   * cost an add and a remove sixty times a second, so the handler reads the latest value through
   * a ref instead of closing over it.
   */
  const readingRef = useRef<Identity | null>(null);
  useEffect(() => {
    readingRef.current = reading;
  });

  const copy = useCallback(
    (value: string): void => {
      void navigator.clipboard
        .writeText(value)
        .then(() => notice.notify(`Copied ${value}`, { key: "inspector-copy" }))
        .catch(() =>
          notice.notify("This browser refused the clipboard", { key: "inspector-copy" }),
        );
    },
    [notice],
  );

  /**
   * The pointer, coalesced to one paint per frame. A `pointermove` fires far more often than the
   * screen refreshes, and every one of them would otherwise re-render the chip — the same reason
   * the tile preview overlay reads its pointer through a store instead of state.
   */
  const pendingAim = useRef<Aim | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (!armed) return;
    const onMove = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      pendingAim.current = { x: event.clientX, y: event.clientY, element: target };
      if (frame.current !== null) return;
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        setAim(pendingAim.current);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [armed]);

  /**
   * A PRESS PINS, and nothing about it reaches the workspace underneath.
   *
   * All three press events are taken in the CAPTURE phase and stopped, because the mode's whole
   * promise is that inspecting changes nothing: a press that pinned a terminal AND focused it,
   * or that pinned a canvas node AND started dragging it, would break that promise the first
   * time anybody used it — and `xterm` and React Flow listen on `pointerdown` and `mousedown`
   * respectively, so suppressing `click` alone suppresses nothing that matters. The card's own
   * subtree is excluded, or pressing Copy would re-pin the card.
   */
  useEffect(() => {
    if (!armed) return;
    const onPress = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".inspector-card") !== null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== "pointerdown" || !(event instanceof PointerEvent)) return;
      const identity = identify(ancestryOf(target), context);
      /*
        "WHAT IS UNDER THIS THING" is measured from the element that DECLARED the subject, not
        from whatever pixel the press landed on. Pressing a section's header text would
        otherwise report the header's own descendants — zero things, no doors — while the card
        says it is describing the section, and a reading that disagrees with its own heading is
        worse than no reading.
      */
      const attribute = identity.subject?.attribute;
      const scope =
        attribute === undefined ? target : (target.closest(`[${attribute}]`) ?? target);
      setPin({
        aim: { x: event.clientX, y: event.clientY, element: target },
        identity,
        subtree: subtreeOf(scope),
      });
      setResolved(null);
      setOccupants(null);
    };
    const types = ["pointerdown", "mousedown", "click"] as const;
    for (const type of types) window.addEventListener(type, onPress, true);
    return () => {
      for (const type of types) window.removeEventListener(type, onPress, true);
    };
  }, [armed, context]);

  /**
   * THE MODE'S OWN TWO KEYS, neither of which is a declared binding row.
   *
   * `Escape` is the universal "never mind" of whatever is armed, and a row would claim it
   * against every dialog in the product too. A pin is the inner level, so Escape releases it
   * first and leaves the mode on the second press.
   *
   * `c` copies the address of whatever is being read — the hovered thing, or the pinned one.
   * The CHIP cannot carry the copy control the card does: the hover layer is
   * `pointer-events: none` by design, because chrome you could click would change what it is
   * describing. A key is the honest affordance for "give me this deep link without pinning it",
   * and it is scoped to the mode rather than declared globally for the same reason Escape is.
   */
  useEffect(() => {
    if (!armed) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pin !== null) {
          setPin(null);
          return;
        }
        toggleInspector();
        return;
      }
      if (event.key !== "c" || event.ctrlKey || event.metaKey || event.altKey) return;
      const uri = readingRef.current?.uri;
      if (uri === undefined || uri === null) return;
      event.preventDefault();
      copy(uri);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, pin, copy]);

  /** The mode's own cursor, restored on the way out. Imperative because it is about the DEVICE. */
  useEffect(() => {
    if (!armed) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "crosshair";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [armed]);

  /** Leaving the mode drops the pin: a card floating over a workspace nobody is inspecting. */
  useEffect(() => {
    if (armed) return;
    setPin(null);
    setAim(null);
  }, [armed]);

  /**
   * A PIN ASKS THE WORKSPACE, and only a pin does. Hovering is a local read of the page's own
   * markup — it must stay free enough to run on every frame — while pinning is a deliberate act,
   * so it is where the two genuinely external questions go: does this address still name
   * anything (`/api/resolve`, the one door onto that question), and who is in the room it names.
   */
  const uri = pin?.identity.uri ?? null;
  useEffect(() => {
    if (uri === null) return;
    let live = true;
    void host.client
      .resolve(uri)
      .then((answer) => {
        if (live) setResolved(answer);
      })
      .catch(() => {
        /* An address the door refuses is reported as unresolved by the absent answer. */
      });
    const ref = parseManifoldUri(uri);
    const containerId =
      ref === null
        ? null
        : ref.kind === "container"
          ? ref.containerId
          : ref.kind === "element" || ref.kind === "tile"
            ? ref.containerId
            : null;
    if (containerId === null) return;
    void host.client
      .attendanceByContainer()
      .then((attendance) => {
        if (!live) return;
        setOccupants(attendance.find((row) => row.containerId === containerId)?.principals ?? []);
      })
      .catch(() => {
        /* Presence is never load-bearing here: the row simply stays "not a room". */
      });
    return () => {
      live = false;
    };
  }, [uri, host.client]);

  if (!armed) return null;
  return (
    <div className="inspector" data-inspector-armed="true">
      {aim === null || hovered === null || pin !== null ? null : (
        <div className="inspector-chip" style={placedAt(aim.x + 14, aim.y + 16, CHIP_BOX)}>
          <IdentityBlock
            identity={hovered}
            host={host}
            painter={painterOf(hovered.subject, registry)}
            onCopy={null}
          />
        </div>
      )}
      {pin === null ? null : (
        <PinCard
          pin={pin}
          host={host}
          painter={painterOf(pin.identity.subject, registry)}
          resolved={resolved}
          occupants={occupants}
          onCopy={copy}
          onClose={() => setPin(null)}
        />
      )}
    </div>
  );
}

/**
 * The two boxes' declared sizes, mirroring `styles.css`. They exist so a reading taken at the
 * right-hand edge of the screen is still readable: a chip that follows the pointer off-screen
 * is a chip that stops answering exactly where the sidebar rail and the identity footer live.
 */
const CHIP_BOX = { width: 320, height: 190 } as const;
const CARD_BOX = { width: 400, height: 460 } as const;
const EDGE_GUTTER = 10;

function placedAt(
  x: number,
  y: number,
  box: { readonly width: number; readonly height: number },
): { readonly left: string; readonly top: string } {
  const left = Math.max(EDGE_GUTTER, Math.min(x, window.innerWidth - box.width - EDGE_GUTTER));
  const top = Math.max(EDGE_GUTTER, Math.min(y, window.innerHeight - box.height - EDGE_GUTTER));
  return { left: `${String(Math.round(left))}px`, top: `${String(Math.round(top))}px` };
}
