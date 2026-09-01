import {
  useProjection,
  type ProjectionRegistry,
  type WorkspaceOverlayProps,
} from "@manifold/plugin/hooks";
import { currentVantage, setVantage, useNotice, useVantage } from "@manifold/plugin/ui";
import {
  GrantsSchema,
  MANIFOLD_ROOT_URI,
  containmentPath,
  formatManifoldUri,
  parseManifoldUri,
  type ActionDenial,
  type Grant,
  type GrantPrincipal,
  type Principal,
  type ResolveResponse,
} from "@manifold/protocol";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { z } from "zod";

import { ancestryOf, declaringChainOf, subtreeOf, type Subtree } from "./dom.ts";
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
 * the chip is a JOIN of things the page already holds (the DOM's own declarations, the live
 * assembly) with things existing doors already answer, and it holds no state of its own about
 * the workspace.
 *
 * READ-ONLY, and structurally so: it MUTATES nothing, opens no pipe, writes no document. It
 * does dispatch — four read doors, and only from a PIN: `/api/resolve` and `/api/attendance`
 * for what an address names and who is in it, `core.access.listGrants` for the authority that
 * reaches it, and `core.events.list` for the trace ledger's last word on it. Every one is a
 * read somebody else already published; none of them is reachable except by deliberately
 * pinning a reading, and three of the four are root-only, so a non-root reader gets the
 * door's own refusal printed as an answer rather than a section that quietly says nothing.
 * The only thing it WRITES anywhere is `vantage.tool`, which is how a mode becomes observable
 * (A2) — a collaborator can see that this principal is inspecting rather than working, and an
 * agent can read the mode back. Its other affordances — copy, and navigating a breadcrumb hop
 * — are the clipboard and the host's own navigation.
 *
 * THE DOORS ARE NAMED AS STRINGS, deliberately and by the same rule the Index's terminal
 * rename follows: a plugin never imports another plugin's package (that is gate RED, S-checks),
 * so a foreign door is reached by its published name and its answer is parsed against a schema
 * this file owns. `core.events` and `core.access` may both be switched off, and when they are
 * the dispatch answers `plugin_disabled` — which is exactly the sentence the section prints.
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
  /**
   * The element that DECLARED the subject, not the pixel the press landed on. It is what the
   * subtree was measured from and what the highlight outlines, so the box a reader sees and the
   * count the card prints describe the same box.
   */
  readonly scope: Element;
  readonly identity: Identity;
  readonly subtree: Subtree;
  /**
   * The declaring ancestors, outermost first and index-aligned with `identity.chain`. Captured
   * at the pin because the breadcrumb's hops highlight and scroll to them, and a walk taken
   * later would be a walk of a DOM that has since re-rendered.
   */
  readonly boxes: readonly Element[];
}

/**
 * WHAT A DOOR ANSWERED, in the only three states a caller can be in. A refusal is DATA here
 * (`ActionOutcome`), so it is a member of this union rather than an exception: the whole point
 * of the authority and trace sections is that "you may not read this" is itself the reading,
 * and a `null` standing for both "still asking" and "was told no" is the shape that loses it.
 *
 * `refused` carries a `rule` that may be absent, and the absence is the honest distinction: a
 * rung off the denial ladder is the SERVER'S word for why, while an answer that arrived and
 * could not be parsed has no rung — inventing one to fill the column would put a word in the
 * ladder's mouth. Both are failures to read, which is why they share an arm.
 */
type Answer<T> =
  | { readonly state: "asking" }
  | { readonly state: "answered"; readonly value: T }
  | { readonly state: "refused"; readonly message: string; readonly rule: string | null };

const ASKING = { state: "asking" } as const;

/** A read that failed, in the shape {@link Answer} keeps it. */
function unreadable(denial: ActionDenial | null, fallback: string): Answer<never> {
  return denial === null
    ? { state: "refused", message: fallback, rule: null }
    : { state: "refused", message: denial.message, rule: denial.rule };
}

/**
 * The two foreign doors, by published name. See the module note on why they are strings.
 */
const GRANTS_DOOR = "core.access.listGrants";
const EVENTS_DOOR = "core.events.list";

/**
 * THE TRACE ROW AS THIS CARD READS IT, and deliberately not `core.events`' own `EventRowSchema`:
 * importing that would be one plugin reaching into another's package, which composition refuses
 * by name. The shape is not folklore either — the roster publishes it as JSON Schema at
 * `GET /api/protocol`, and this is the ordinary position of any consumer that is not the
 * producer.
 *
 * LENIENT where the producer is strict, and that is the difference in role rather than rigour:
 * `core.events` owns the row and must refuse a field it never wrote, while a reader must keep
 * reading when the row grows one. Only the row's own id and the five columns the section prints
 * are named, unknown keys are dropped, and the A6 vocabulary (`outcome`) stays TEXT for the
 * reason the producer publishes it as text — a word a newer server writes and this build has
 * never heard of must read as a row, not poison the page.
 */
const TraceRowSchema = z.object({
  id: z.number(),
  ts: z.number(),
  principalId: z.string().nullable(),
  door: z.string().nullable(),
  outcome: z.string().nullable(),
  targets: z.array(z.string()),
});
const TraceListSchema = z.object({ events: z.array(TraceRowSchema) });
type TraceRow = z.infer<typeof TraceRowSchema>;

/** The `type` column's word for a trace row: the ledger's own discriminator (A6, ADR 0018). */
const TRACE_KIND = "trace";

/** How many matches the card shows at once, and how many more each press of "load more" adds. */
const TRACE_PAGE = 5;

/**
 * HOW DEEP THE SCAN GOES, in trace rows asked of the door — not in matches.
 *
 * `core.events.list` filters by kind and by container and orders by recency; it has no filter on
 * `targets` and no cursor, so "this node's history" is a JOIN the reader performs: ask for the
 * newest N traces, keep the ones that named this address. That is the honest cost of the A6
 * ledger being one table rather than a per-node index, and it is why the card prints the
 * DENOMINATOR beside the matches — "3 in the newest 100 traces" is a true sentence where "3
 * traces" would be a guess.
 *
 * Two depths, because the door publishes a maximum (500) and there is nothing between the
 * default and it worth a third round trip. The maximum is this file's BELIEF about somebody
 * else's schema, and being wrong about it is visible rather than silent: a limit past the bound
 * is refused as `invalid_args`, which the section prints verbatim.
 */
const TRACE_SCAN = [100, 500] as const;

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
 *
 * `onCopy` and `onNavigate` are null for the CHIP and only for the chip, and they are two props
 * rather than one `interactive` flag because they are two different doors. The hover layer is
 * `pointer-events: none` by design — chrome you could press would change what it is describing —
 * so a control painted there would be a control that never answers.
 */
function IdentityBlock({
  identity,
  host,
  painter,
  onCopy,
  onNavigate,
}: {
  readonly identity: Identity;
  readonly host: WorkspaceOverlayProps["host"];
  readonly painter: Painter | null;
  readonly onCopy: ((uri: string) => void) | null;
  readonly onNavigate: ((uri: string) => void) | null;
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
            {/*
              THE OWNER IS AN ADDRESS, so it is navigable like every other address on this card.
              A plugin's `manifold://plugin/<id>` is one of the seven forms (invariant 13) and
              the host's own navigation is the one door onto "put the viewer there" — the
              inspector neither knows nor cares what the plugin manager does when it arrives.
            */}
            {onNavigate === null ? (
              owner.manifest.title
            ) : (
              <button
                type="button"
                className="inspector-hop"
                title={formatManifoldUri({ kind: "plugin", pluginId: owner.manifest.id })}
                onClick={() =>
                  onNavigate(formatManifoldUri({ kind: "plugin", pluginId: owner.manifest.id }))
                }
              >
                {owner.manifest.title}
              </button>
            )}{" "}
            <span className="inspector-muted">{owner.manifest.id}</span>{" "}
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
 * ONE HOP OF THE PATH, whatever produced it: what to call it, where pressing it sends the
 * viewer, and which box on screen it is painted in. All three are independently absent — the
 * workspace root has no route, a sidebar section has no address, a container has no box — and
 * a hop that is missing one still answers the others.
 */
interface Crumb {
  readonly label: string;
  /** Where `host.navigate` is asked to go, or null when the hop names nothing routable. */
  readonly uri: string | null;
  /** The box it occupies, or null when nothing in this document declares it. */
  readonly box: Element | null;
}

/** What one hop of the ADDRESS path is called, in the noun-then-id shape the DOM hops use. */
function addressLabel(uri: string): string {
  if (uri === MANIFOLD_ROOT_URI) return "workspace";
  const ref = parseManifoldUri(uri);
  if (ref === null) return uri;
  switch (ref.kind) {
    case "terminal":
      return `terminal ${ref.terminalId}`;
    case "container":
      return `container ${ref.containerId}`;
    case "element":
      return `element ${ref.elementId}`;
    case "tile":
      return `tile ${ref.tileId}`;
    case "principal":
      return `principal ${ref.principalId}`;
    case "plugin":
      return `plugin ${ref.pluginId}`;
    case "action":
      return `door ${ref.actionName}`;
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}

/**
 * THE PATH, AS ONE CHAIN — outermost first, `workspace › container › tile › element`.
 *
 * It was two rows, and two rows was a defect rather than a shape: the DOM chain and the address
 * chain describe the SAME descent through the same tree, so printing both flat gave a reader two
 * unordered bags of chips restating each other and no sense of what contained what.
 *
 * They are still two SOURCES, because neither is complete on its own and neither can be
 * dropped. The DOM chain is finer — it holds the sections, panels and tiles that carry no
 * address at all — while `containmentPath` holds the ancestors this document never declares:
 * nothing in the page is marked with a container id, and the workspace root is marked nowhere by
 * construction. So the address ancestors that no DOM hop already spells become the PREFIX, and
 * the declared chain is the rest. The subject's own address is dropped from that prefix
 * (`slice(0, -1)`): it is the last hop of the declared chain, and a path whose final two hops
 * were one node spelled twice is the repetition this row exists to end.
 *
 * Hops keep their own address rather than borrowing the subject's, exactly as before: a
 * breadcrumb whose hops all navigated to the same place would be chrome pretending to be a path.
 */
function pathOf(pin: Pin, routedContainerId: string | null): readonly Crumb[] {
  const declared: Crumb[] = pin.identity.chain.map((hop, index) => ({
    label: `${hop.kind} ${hop.id}`,
    uri: declarationAddress(hop, routedContainerId),
    box: pin.boxes[index] ?? null,
  }));
  const spelled = new Set(declared.map((crumb) => crumb.uri));
  const address = pin.identity.uri === null ? [] : (containmentPath(pin.identity.uri) ?? []);
  const prefix: Crumb[] = address
    .slice(0, -1)
    .filter((uri) => !spelled.has(uri))
    .map((uri) => ({
      label: addressLabel(uri),
      // The root is the one node with no ref form, so there is nothing for a route to carry.
      uri: uri === MANIFOLD_ROOT_URI ? null : uri,
      box: null,
    }));
  return [...prefix, ...declared];
}

/**
 * One hop, painted. A hop with an address is a button and navigates; a hop without one is prose,
 * because a control that answers nothing is worse than no control.
 *
 * EITHER KIND AIMS THE HIGHLIGHT when it has a box, which is why the pointer handlers sit on
 * both: "where is this thing?" is a question the inert hops answer best, since a section and a
 * panel are precisely the parts of the workspace that have no address to navigate to.
 */
function CrumbHop({
  crumb,
  onNavigate,
  onAim,
}: {
  readonly crumb: Crumb;
  readonly onNavigate: (uri: string) => void;
  readonly onAim: (box: Element | null) => void;
}): ReactElement {
  const box = crumb.box;
  const aiming =
    box === null
      ? {}
      : {
          onPointerEnter: () => {
            onAim(box);
          },
          onPointerLeave: () => {
            onAim(null);
          },
        };
  if (crumb.uri === null) {
    return (
      <span className="inspector-hop is-inert" {...aiming}>
        {crumb.label}
      </span>
    );
  }
  const uri = crumb.uri;
  return (
    <button
      type="button"
      className="inspector-hop"
      title={uri}
      onClick={() => {
        onNavigate(uri);
      }}
      {...aiming}
    >
      {crumb.label}
    </button>
  );
}

/** A grant, plus whether it reaches this node from ABOVE it. */
interface Reaching {
  readonly grant: Grant;
  readonly inherited: boolean;
}

/**
 * WHO, at the width a card has for it. A principal id is a 36-character UUID, and five of them
 * stacked down a 25rem column is a block of noise that discriminates nothing — the head tells
 * two actors apart, and the whole id is one hover (and one `title`) away for anybody who needs
 * to paste it. Truncating in the DOM rather than with `text-overflow` is deliberate: an
 * ellipsis painted by CSS cannot be copied, and this is a value readers copy.
 */
function Who({ id }: { readonly id: string }): ReactElement {
  return (
    <span className="inspector-muted" title={id}>
      {id.length > 12 ? `${id.slice(0, 8)}…` : id}
    </span>
  );
}

/**
 * WHO a grant row names, in words rather than in its discriminator. The class forms are the
 * reason grants exist as rows at all (ADR 0011), so they read as the sentences they are; only
 * the one form that carries an opaque id is abbreviated.
 */
function Grantee({ principal }: { readonly principal: GrantPrincipal }): ReactElement {
  switch (principal.kind) {
    case "principal":
      return <Who id={principal.id} />;
    case "any-human":
      return <>any human</>;
    case "any-agent":
      return <>any agent</>;
    case "instance":
      return <span title={principal.origin}>{principal.origin}</span>;
    default: {
      const exhaustive: never = principal;
      return exhaustive;
    }
  }
}

/**
 * WHEN, at the resolution a reader of an audit trail actually wants: the clock for anything
 * inside the last day, the date as well past it. Relative to the instant the rows were READ
 * rather than to `Date.now()` in render, so the label describes the answer it was printed with.
 */
const DAY_MS = 86_400_000;

function when(ts: number, readAt: number): string {
  const at = new Date(ts);
  return readAt - ts < DAY_MS ? at.toLocaleTimeString() : at.toLocaleString();
}

/** What one scan of the ledger found for this node, and how far it had to look to find it. */
interface TraceReading {
  readonly matches: readonly TraceRow[];
  /** How many trace rows the door was asked for — the denominator the card prints. */
  readonly scanned: number;
  /** True once the scan is as deep as the door will go. */
  readonly exhausted: boolean;
  readonly readAt: number;
}

/**
 * A DOOR'S REFUSAL, printed as the answer it is. The message is the SERVER'S — this card never
 * paraphrases it and never guesses at it from `selfCaps()`, because an unjoined workspace handle
 * holds no caps at all and would make every reader look unprivileged. Asking and being told is
 * one round trip either way, and the sentence that comes back is the true one.
 */
function Refused({
  message,
  rule,
}: {
  readonly message: string;
  readonly rule: string | null;
}): ReactElement {
  return (
    <span className="inspector-absent">
      {message} {rule === null ? null : <span className="inspector-muted">{rule}</span>}
    </span>
  );
}

/**
 * THE PINNED CARD: the identity block, the one path this thing sits on, what is under it, every
 * door it reaches, who is in it, the authority that reaches it and the ledger's last word on it.
 *
 * The sections are ordered from the thing outward — what it is, where it sits, what it holds,
 * who is in it, who may act on it, what has been done to it — and each is one `Row`, so a new
 * section is one more row at the end rather than a new layout.
 */
function PinCard({
  pin,
  host,
  painter,
  resolved,
  occupants,
  grants,
  traces,
  shown,
  onCopy,
  onClose,
  onAim,
  onMore,
}: {
  readonly pin: Pin;
  readonly host: WorkspaceOverlayProps["host"];
  readonly painter: Painter | null;
  readonly resolved: ResolveResponse | null;
  readonly occupants: readonly Principal[] | null;
  readonly grants: Answer<readonly Reaching[]>;
  readonly traces: Answer<TraceReading>;
  readonly shown: number;
  readonly onCopy: (uri: string) => void;
  readonly onClose: () => void;
  readonly onAim: (box: Element | null) => void;
  readonly onMore: () => void;
}): ReactElement {
  const roster = host.assembly.roster();
  const path = pathOf(pin, host.containerId);
  const navigate = (uri: string): void => {
    host.navigate(uri);
  };
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
      <IdentityBlock
        identity={pin.identity}
        host={host}
        painter={painter}
        onCopy={onCopy}
        onNavigate={navigate}
      />
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
        <Row label="path">
          <span className="inspector-path">
            {path.map((crumb, index) => (
              <Fragment key={`${crumb.label}:${String(index)}`}>
                {index === 0 ? null : (
                  <span className="inspector-path__seam" aria-hidden="true">
                    ›
                  </span>
                )}
                <CrumbHop crumb={crumb} onNavigate={navigate} onAim={onAim} />
              </Fragment>
            ))}
          </span>
        </Row>
        <Row label="holds">
          {String(pin.subtree.children)} declared {pin.subtree.children === 1 ? "thing" : "things"}
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
        {/*
          EFFECTIVE AUTHORITY, which is the walk and not the row. `listGrants({ node })` matches
          one node exactly, so the rows that decide what may happen HERE are the union over the
          containment path — a `subtree` grant at the container reaches the element under it (A5),
          a `node` grant at an ancestor does not. Printing only the rows filed at this exact
          address would answer a different question than the evaluator asks.
        */}
        <Row label="authority">
          {pin.identity.uri === null ? (
            <span className="inspector-absent">no address to hold authority over</span>
          ) : grants.state === "asking" ? (
            <span className="inspector-muted">asking the workspace…</span>
          ) : grants.state === "refused" ? (
            <Refused message={grants.message} rule={grants.rule} />
          ) : grants.value.length === 0 ? (
            <span className="inspector-muted">no grant reaches this node</span>
          ) : (
            <span className="inspector-grants">
              {grants.value.map(({ grant, inherited }) => (
                <span key={grant.id} className="inspector-grant">
                  <span className={grant.effect === "deny" ? "inspector-absent" : "inspector-noun"}>
                    {grant.effect}
                  </span>{" "}
                  <code className="inspector-door">{grant.caps.join(" ")}</code>{" "}
                  <Grantee principal={grant.principal} />{" "}
                  <span className="inspector-muted">
                    {inherited ? `${grant.reach} · from ${addressLabel(grant.node)}` : grant.reach}
                  </span>
                </span>
              ))}
            </span>
          )}
        </Row>
        {/*
          THE LEDGER'S LAST WORD ON THIS NODE — the A6 join, and only a join: `core.events.list`
          answers the newest traces, `targets` says which nodes each one named, and the match is
          this address appearing in that array. The denominator is printed beside the count
          because the scan is bounded (see {@link TRACE_SCAN}) and "no history" and "none in the
          newest hundred" are different sentences.
        */}
        <Row label="trace">
          {pin.identity.uri === null ? (
            <span className="inspector-absent">no address the ledger could have named</span>
          ) : traces.state === "asking" ? (
            <span className="inspector-muted">reading the ledger…</span>
          ) : traces.state === "refused" ? (
            <Refused message={traces.message} rule={traces.rule} />
          ) : (
            <span className="inspector-traces">
              {traces.value.matches.slice(0, shown).map((row) => (
                <span key={String(row.id)} className="inspector-trace">
                  <code className="inspector-door">{row.door ?? "—"}</code>
                  <span
                    className={`inspector-outcome ${row.outcome === "ok" ? "is-ok" : row.outcome === null ? "is-open" : "is-refused"}`}
                  >
                    {row.outcome ?? "unsettled"}
                  </span>
                  {row.principalId === null ? (
                    <span className="inspector-muted">nobody</span>
                  ) : (
                    <Who id={row.principalId} />
                  )}
                  <span className="inspector-muted">{when(row.ts, traces.value.readAt)}</span>
                </span>
              ))}
              <span className="inspector-muted">
                {traces.value.matches.length === 0
                  ? `nothing in the newest ${String(traces.value.scanned)} traces`
                  : `${String(Math.min(shown, traces.value.matches.length))} of ${String(traces.value.matches.length)} in the newest ${String(traces.value.scanned)} traces`}
                {shown < traces.value.matches.length || !traces.value.exhausted ? (
                  <button type="button" className="inspector-copy" onClick={onMore}>
                    Load more
                  </button>
                ) : (
                  " — as deep as the door reads"
                )}
              </span>
            </span>
          )}
        </Row>
      </dl>
      <p className="inspector-hint">
        {`Pinned — hover is frozen. ${String(roster.length)} plugins are assembled; Esc unpins, F10 leaves.`}
      </p>
    </section>
  );
}

/**
 * THE OUTLINE: one box painted over the workspace to say "this one".
 *
 * OVER, and structurally so — a `position: fixed` div in the inspector's own layer, sized from
 * the target's `getBoundingClientRect()`. Nothing is written to the inspected element: an
 * outline set on the subject itself would change its box, which for a mode whose whole promise
 * is that looking changes nothing is the one thing it must not do. It also could not be relied
 * on: half the things worth pointing at (a React Flow node, a terminal's tile) are owned by code
 * that rewrites its own style attribute.
 *
 * MEASURED AFTER EVERY RENDER, and on scroll and resize in between, through a ref rather than a
 * dependency: the hovered target changes on every pointer frame, and an effect keyed on the
 * element would tear down and re-register two listeners sixty times a second to observe the same
 * two events. The measure writes `style` directly, so a scroll costs one rect read and three
 * property writes and no React render at all.
 */
function Highlight({
  element,
  tone,
}: {
  readonly element: Element;
  readonly tone: "subject" | "hop";
}): ReactElement {
  const painted = useRef<HTMLDivElement | null>(null);
  const target = useRef(element);
  const measure = useCallback((): void => {
    const node = painted.current;
    if (node === null) return;
    const rect = target.current.getBoundingClientRect();
    node.style.transform = `translate(${String(Math.round(rect.left))}px, ${String(Math.round(rect.top))}px)`;
    node.style.width = `${String(Math.round(rect.width))}px`;
    node.style.height = `${String(Math.round(rect.height))}px`;
  }, []);
  useEffect(() => {
    target.current = element;
    measure();
  });
  useEffect(() => {
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    // Capturing, because the box may live inside a scroller of its own (the sidebar, a pane).
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [measure]);
  return <div ref={painted} className={`inspector-highlight is-${tone}`} aria-hidden="true" />;
}

/**
 * THE CARD'S OWN CONTENT, for the press handler that suppresses everything else.
 *
 * A LIST rather than one selector, because a portal breaks the DOM ancestry a subtree test
 * relies on. `.popover__content` is `@manifold/plugin/ui`'s portalled layer: content opened
 * from inside the card is rendered at the end of `body`, so a press in it is a press "outside"
 * the card by every containment test there is — and the pin it would otherwise take is a pin of
 * the very control the reader is using. Named here rather than styled here: this file paints
 * nothing outside its own family.
 */
const CARD_SUBTREES = [".inspector-card", ".popover__content"] as const;

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
  const [grants, setGrants] = useState<Answer<readonly Reaching[]>>(ASKING);
  const [traces, setTraces] = useState<Answer<TraceReading>>(ASKING);
  /**
   * HOW FAR THE LEDGER HAS BEEN ASKED, and how much of what came back is on screen. Two numbers
   * rather than one, because "load more" means two different things at two different moments:
   * first show more of what the scan already found, and only when that is exhausted go back to
   * the door for a deeper one. Both are the reader's position in an answer, so they live here
   * beside the answer rather than inside the card that prints it.
   */
  const [depth, setDepth] = useState(0);
  const [shown, setShown] = useState(TRACE_PAGE);
  /**
   * The box a breadcrumb hop is currently pointing at, or null. Only a PIN can produce one — the
   * hops live on the card — which is the same reason the pointer stops being tracked at a pin.
   */
  const [aimedBox, setAimedBox] = useState<Element | null>(null);

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
   *
   * A PIN FREEZES IT, and the freeze is the absence of the listener rather than a branch inside
   * it. That is what makes the pinned card usable at all: the pointer has to be able to travel
   * across the workspace and into the card to press Copy, load more traces or follow a hop, and
   * a reading that kept re-aiming on the way there would be describing the card's own chrome by
   * the time the pointer arrived. It also costs nothing while pinned — no handler, no frame, no
   * ancestor walk — which is the state a reader sits in for as long as they are reading.
   */
  const pendingAim = useRef<Aim | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (!armed || pin !== null) return;
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
  }, [armed, pin]);

  /**
   * A PRESS PINS, and nothing about it reaches the workspace underneath.
   *
   * All three press events are taken in the CAPTURE phase and stopped, because the mode's whole
   * promise is that inspecting changes nothing: a press that pinned a terminal AND focused it,
   * or that pinned a canvas node AND started dragging it, would break that promise the first
   * time anybody used it — and `xterm` and React Flow listen on `pointerdown` and `mousedown`
   * respectively, so suppressing `click` alone suppresses nothing that matters.
   *
   * THE CARD'S OWN CONTENT IS EXCLUDED, or pressing Copy would re-pin the card. That exclusion
   * is a list rather than one selector because a portal breaks the DOM ancestry the card's own
   * subtree relies on: a popover opened from the card is rendered at the end of `body`, so a
   * press inside it is a press "outside" the card by every containment test there is, and the
   * pin it would take is of the popover the reader is using to read.
   */
  useEffect(() => {
    if (!armed) return;
    const onPress = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (CARD_SUBTREES.some((selector) => target.closest(selector) !== null)) return;
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
      const scope = attribute === undefined ? target : (target.closest(`[${attribute}]`) ?? target);
      setPin({
        aim: { x: event.clientX, y: event.clientY, element: target },
        scope,
        identity,
        subtree: subtreeOf(scope),
        boxes: declaringChainOf(target),
      });
      /*
        WHAT A PIN RESETS IS THE READER'S POSITION, never the answers. Each answer is owned by
        the effect that asks for it and cleared there, because clearing it here is how a re-pin
        of the SAME address strands a section on "asking…" forever: the address did not change,
        so nothing re-asks, and the state that was blanked is never refilled.
      */
      setDepth(0);
      setShown(TRACE_PAGE);
      setAimedBox(null);
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

  /** Leaving the mode drops the pin: a card floating over a workspace nobody is inspecting.
   * Compared during render rather than reset from an effect (react.dev's remedy for "reset
   * state when a prop changes") — one extra render on the transition, no cascade. */
  const [wasArmed, setWasArmed] = useState(armed);
  if (wasArmed !== armed) {
    setWasArmed(armed);
    if (!armed) {
      setPin(null);
      setAim(null);
      setAimedBox(null);
    }
  }

  /**
   * A PIN ASKS THE WORKSPACE, and only a pin does. Hovering is a local read of the page's own
   * markup — it must stay free enough to run on every frame — while pinning is a deliberate act,
   * so it is where every genuinely external question goes: does this address still name anything
   * (`/api/resolve`, the one door onto that question), who is in the room it names, what
   * authority reaches it, and what the ledger says was done to it.
   */
  const uri = pin?.identity.uri ?? null;

  /**
   * EVERY ANSWER BELONGS TO AN ADDRESS, and is dropped the instant the address changes.
   *
   * Compared during render rather than cleared from the effects that ask — react.dev's own
   * remedy for "reset state when a prop changes", the pattern `wasArmed` above already follows,
   * and the one the effect lint enforces. It is also the only version that gets the two edge
   * cases right: re-pinning the SAME address keeps the answers it already has (clearing them in
   * the press handler stranded every section on "asking…", because nothing re-asks an address
   * that did not change), and a DEEPER trace scan keeps the rows on screen, because widening
   * does not change the address either.
   */
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  if (answeredFor !== uri) {
    setAnsweredFor(uri);
    setResolved(null);
    setOccupants(null);
    setGrants(ASKING);
    setTraces(ASKING);
  }

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

  /**
   * EFFECTIVE AUTHORITY AT THIS NODE, asked the way the evaluator asks it and joined here.
   *
   * `listGrants({ node })` matches ONE node exactly — it is a filter on a column, not a walk —
   * so one call per hop of the containment path is what "the rows that decide what happens here"
   * costs. Three calls at most, because the address algebra is three deep at most: a grant is
   * filed at the root, at a container, or at the leaf. Rows from an ancestor count only when
   * their reach is `subtree`, which is A5 spelled as a filter: permission granted at a node
   * flows downward, and a `node` grant deliberately does not.
   *
   * ROOT-ONLY, and the refusal is the answer rather than a hidden section — `core.access` says
   * so in its own words, quoted verbatim by {@link Refused}.
   */
  useEffect(() => {
    if (uri === null) return;
    let live = true;
    const path = containmentPath(uri) ?? [];
    void (async (): Promise<void> => {
      try {
        const answers = await Promise.all(
          path.map(async (node) => ({
            node,
            outcome: await host.client.action(GRANTS_DOOR, { node }),
          })),
        );
        if (!live) return;
        const reaching: Reaching[] = [];
        for (const { node, outcome } of answers) {
          if (!outcome.ok) {
            setGrants(unreadable(outcome.denial, ""));
            return;
          }
          const parsed = GrantsSchema.safeParse(outcome.result);
          if (!parsed.success) {
            setGrants(unreadable(null, "the grant rows could not be read"));
            return;
          }
          const inherited = node !== uri;
          for (const grant of parsed.data.grants) {
            if (inherited && grant.reach !== "subtree") continue;
            reaching.push({ grant, inherited });
          }
        }
        setGrants({ state: "answered", value: reaching });
      } catch {
        if (live) setGrants(unreadable(null, "the workspace could not be asked"));
      }
    })();
    return () => {
      live = false;
    };
  }, [uri, host.client]);

  /**
   * THIS NODE'S TRACE HISTORY (A6): the newest rows of the ONE journal that named this address.
   *
   * The join is performed HERE because the door does not perform it — `core.events.list` narrows
   * by kind and by container and orders by recency, and `targets` is a column it publishes
   * rather than a filter it accepts. Asking for `kind: "trace"` is what makes the depth mean
   * something: every row that comes back is an exercise of authority, so "the newest 100" is a
   * hundred acts on this workspace rather than a hundred lines of lifecycle noise.
   *
   * `depth` is the whole of the paging, and re-reading on a change of it is deliberate: the door
   * has no cursor, so a deeper page is the same question asked wider, and the second answer
   * CONTAINS the first. That containment is why widening does not blank the section: the rows on
   * screen are still true while the deeper read is in flight, and only a change of ADDRESS drops
   * them — which the render-phase reset above already does, and this effect therefore need not.
   */
  useEffect(() => {
    if (uri === null) return;
    let live = true;
    const limit = TRACE_SCAN[depth] ?? TRACE_SCAN[0];
    void (async (): Promise<void> => {
      try {
        const outcome = await host.client.action(EVENTS_DOOR, { kind: TRACE_KIND, limit });
        if (!live) return;
        if (!outcome.ok) {
          setTraces(unreadable(outcome.denial, ""));
          return;
        }
        const parsed = TraceListSchema.safeParse(outcome.result);
        if (!parsed.success) {
          setTraces(unreadable(null, "the ledger's answer could not be read"));
          return;
        }
        const scanned = parsed.data.events.length;
        setTraces({
          state: "answered",
          value: {
            matches: parsed.data.events.filter((row) => row.targets.includes(uri)),
            scanned,
            /*
              Two ways to be at the bottom, and both are real: the door will not read deeper
              than its published maximum, and a ledger holding fewer rows than were asked for
              has no deeper to go. Saying "load more" to either would be a control that
              re-asks the identical question.
            */
            exhausted: depth >= TRACE_SCAN.length - 1 || scanned < limit,
            readAt: Date.now(),
          },
        });
      } catch {
        if (live) setTraces(unreadable(null, "the workspace could not be asked"));
      }
    })();
    return () => {
      live = false;
    };
  }, [uri, depth, host.client]);

  /**
   * MORE, which means two things in order: more of what the scan already found, and — only once
   * that is spent — a deeper scan. Deciding here rather than in the card keeps the card a
   * printer of an answer, and keeps the second round trip from being paid for a page the first
   * answer already contains.
   */
  const more = useCallback((): void => {
    setShown((count) => count + TRACE_PAGE);
    setDepth((current) => {
      if (traces.state !== "answered" || traces.value.exhausted) return current;
      return shown + TRACE_PAGE <= traces.value.matches.length ? current : current + 1;
    });
  }, [traces, shown]);

  /**
   * A HOP AIMS THE HIGHLIGHT, and brings its target into view when it is not already there.
   *
   * `block: "nearest"` is load-bearing: a hop whose box is already on screen must move nothing
   * at all, because a card that scrolled the workspace every time the pointer crossed a
   * breadcrumb would be a reading tool rearranging what it reads. Scroll position is the one
   * thing this mode does move, and only on a deliberate hover of a named hop.
   */
  const aimHop = useCallback((box: Element | null): void => {
    setAimedBox(box);
    if (box !== null) box.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  /**
   * THE BOX BEING READ. Pinned, it is the element that DECLARED the subject — the same box the
   * subtree count was measured from, so the outline and the count can never describe two
   * different things. Hovering, it is the nearest ancestor of the pointer's target carrying the
   * subject's own attribute, so pointing at two words of a section's header outlines the
   * section. Nothing declared under the pointer means nothing outlined: the chip is hidden in
   * that case too, and an outline around whatever `<div>` happened to be there would be the
   * mode claiming to have found something.
   */
  const subject = hovered?.subject ?? null;
  const subjectBox =
    pin !== null
      ? pin.scope
      : aim === null || subject === null
        ? null
        : (aim.element.closest(`[${subject.attribute}]`) ?? aim.element);
  if (!armed) return null;
  return (
    <div className="inspector" data-inspector-armed="true">
      {/*
        THE OUTLINES FIRST, so the chip and the card paint over them rather than under. Two at
        once is the informative case and not a conflict: while a hop is hovered the reader is
        comparing where they ARE with where that hop is, and the two tones are what let them.
      */}
      {subjectBox === null ? null : <Highlight element={subjectBox} tone="subject" />}
      {aimedBox === null ? null : <Highlight element={aimedBox} tone="hop" />}
      {aim === null || hovered === null || pin !== null ? null : (
        <div className="inspector-chip" style={placedAt(aim.x + 14, aim.y + 16, CHIP_BOX)}>
          <IdentityBlock
            identity={hovered}
            host={host}
            painter={painterOf(hovered.subject, registry)}
            onCopy={null}
            onNavigate={null}
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
          grants={grants}
          traces={traces}
          shown={shown}
          onCopy={copy}
          onClose={() => setPin(null)}
          onAim={aimHop}
          onMore={more}
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
