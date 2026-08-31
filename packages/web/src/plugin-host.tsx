import type {
  HostServices,
  PadAuthoringHandle,
  PadViewportHandle,
  PanelProps,
  SectionProps,
} from "@manifold/plugin";
import {
  MANIFOLD_URI_SCHEME,
  parseManifoldUri,
  PluginsResponseSchema,
  type PluginRoster,
} from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type { StoredIdentity } from "./api.ts";
import { WEB_PLUGIN_DEFS } from "./composition.ts";
import { sessionUrl } from "./flow-pad-view.tsx";

/**
 * The browser half of the plugin engine — FLOOR (AXIOMS.md §Foundation), which is why this
 * file never imports a plugin package: `composition.ts` is the one web file allowed to name
 * `@manifold-plugin/*`, and it hands its registrations here as inert data.
 *
 * The division of labour is the whole point:
 *
 * - the ROSTER (`GET /api/plugins`, live on the connection-level `plugins` frame) is the
 *   server-owned VOCABULARY: which plugins exist, whether each is enabled, and what each
 *   declares it contributes. Every list below is derived from it.
 * - `WEB_PLUGIN_DEFS` only ATTACHES components to names the roster already published. A web
 *   half that registers a panel nobody declared contributes nothing; a declared panel with
 *   no registered component renders a placeholder instead of a blank tile.
 *
 * Disabled plugins keep their contributions in every registry, tagged `enabled: false`, for
 * the same reason the engine keeps them server-side: a consumer must be able to say "waiting
 * on core.draw" rather than show nothing (D4).
 */

/**
 * What a plugin's web half attaches for a contributed tool. Deliberately thin this wave —
 * the toolbar still owns selection — and expected to GROW (icon, cursor, activation
 * handler) when the toolbar itself becomes composed; extend this interface rather than
 * inventing a second tool channel.
 */
export interface ToolContribution {
  readonly title?: string;
}

/**
 * One plugin's browser registrations, keyed by the LOCAL contribution name its manifest
 * declared (`sidebar`, not `core.shell.sidebar`) — except `elements`, which are keyed by the
 * wire element type, because that string is what a scene document actually stores.
 *
 * `elements` are typed as opaque components: an element renderer is a React Flow node
 * component whose props are the renderer's private contract, so the flow paint boundary is
 * the one place that casts them into its own node-type map. Nothing else may look inside.
 */
export interface WebPluginDef {
  readonly id: string;
  readonly panels?: Readonly<Record<string, ComponentType<PanelProps>>>;
  readonly sections?: Readonly<Record<string, ComponentType<SectionProps>>>;
  readonly elements?: Readonly<Record<string, ComponentType<never>>>;
  readonly tools?: Readonly<Record<string, ToolContribution>>;
  /**
   * URL space a plugin owns, keyed by FIRST PATH SEGMENT (`uri` serves `/uri/<rest>`).
   * Routes are the one contribution with no manifest counterpart: a path is not a surface
   * the workspace composes, it is an entry point the browser hands over — so the roster
   * still decides whether the owning plugin is ENABLED, and a disabled plugin's route
   * renders the same named placeholder every other contribution does.
   */
  readonly routes?: Readonly<Record<string, ComponentType<{ rest: string; host: HostServices }>>>;
}

/** A declared panel, keyed in the composition by its FULL id (`core.shell.sidebar`). */
export interface WebPanel {
  readonly plugin: string;
  readonly title: string;
  /** Null when the plugin declared the panel but registered no component. */
  readonly Component: ComponentType<PanelProps> | null;
  readonly enabled: boolean;
}

/** A declared sidebar section. Section ids are global (one sidebar, one slot per name). */
export interface WebSection {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly order: number;
  readonly Component: ComponentType<SectionProps> | null;
  readonly enabled: boolean;
}

/** A declared element type, keyed in the composition by the wire type (`draw`). */
export interface WebElement {
  readonly plugin: string;
  readonly title: string;
  readonly Component: ComponentType<never> | null;
  readonly enabled: boolean;
}

/** A declared tool; `contribution` is whatever the web half attached, if anything. */
export interface WebTool {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly contribution: ToolContribution | null;
  readonly enabled: boolean;
}

/**
 * A registered URL space, keyed in the composition by its first path segment. It has no
 * manifest row (see `WebPluginDef.routes`), so `plugin` is the registering plugin and
 * `enabled` is that plugin's roster state.
 */
export interface WebRoute {
  readonly plugin: string;
  readonly Component: ComponentType<{ rest: string; host: HostServices }>;
  readonly enabled: boolean;
}

/**
 * The browser's view of the composition: the roster plus one registry per contribution kind,
 * with components attached. `revision` increments on every roster change, so anything that
 * must be rebuilt when the vocabulary moves (React Flow's node-type map, for one) has a
 * cheap memo key instead of a deep comparison.
 */
export interface WebComposition {
  readonly roster: PluginRoster;
  readonly revision: number;
  /** False for a disabled plugin AND for an id the roster does not carry. */
  enabled(id: string): boolean;
  /** The plugin's human title, for placeholders and admin UI; null when unknown. */
  pluginTitle(id: string): string | null;
  /** Keyed by FULL panel id — the id a `panel` tile surface names. */
  readonly panels: ReadonlyMap<string, WebPanel>;
  /** Sorted by declared `order`; ties keep roster order. */
  readonly sections: readonly WebSection[];
  readonly elements: ReadonlyMap<string, WebElement>;
  /** Keyed by first path segment; a route the roster does not know is simply absent. */
  readonly routes: ReadonlyMap<string, WebRoute>;
  readonly tools: readonly WebTool[];
}

/**
 * Joins the server's vocabulary with the browser's registrations. Pure, and exported so the
 * join is testable without a provider or a socket.
 */
export function buildWebComposition(
  roster: PluginRoster,
  revision: number,
  defs: readonly WebPluginDef[],
): WebComposition {
  const byId = new Map(defs.map((def) => [def.id, def]));
  const titles = new Map<string, string>();
  const enabledIds = new Set<string>();
  const panels = new Map<string, WebPanel>();
  const sections: WebSection[] = [];
  const elements = new Map<string, WebElement>();
  const tools: WebTool[] = [];
  const routes = new Map<string, WebRoute>();

  for (const entry of roster) {
    const { manifest, enabled } = entry;
    const def = byId.get(manifest.id);
    titles.set(manifest.id, manifest.title);
    if (enabled) enabledIds.add(manifest.id);

    for (const panel of manifest.contributes.panels) {
      panels.set(`${manifest.id}.${panel.id}`, {
        plugin: manifest.id,
        title: panel.title,
        Component: def?.panels?.[panel.id] ?? null,
        enabled,
      });
    }
    for (const section of manifest.contributes.sections) {
      sections.push({
        id: section.id,
        plugin: manifest.id,
        title: section.title,
        order: section.order,
        Component: def?.sections?.[section.id] ?? null,
        enabled,
      });
    }
    for (const element of manifest.contributes.elements) {
      elements.set(element.type, {
        plugin: manifest.id,
        title: element.title,
        Component: def?.elements?.[element.type] ?? null,
        enabled,
      });
    }
    for (const tool of manifest.contributes.tools) {
      tools.push({
        id: tool.id,
        plugin: manifest.id,
        title: tool.title,
        contribution: def?.tools?.[tool.id] ?? null,
        enabled,
      });
    }
    // Routes have no manifest row to iterate, so they come from the REGISTRATION and take
    // the registering plugin's roster state — which is what keeps a disabled plugin's deep
    // link rendering a named placeholder instead of a dead end.
    for (const [segment, Component] of Object.entries(def?.routes ?? {})) {
      routes.set(segment, { plugin: manifest.id, Component, enabled });
    }
  }

  // Array#sort is stable, so equal orders keep the roster's own order — the same tiebreak
  // the engine's `composeRoster` applies server-side.
  sections.sort((left, right) => left.order - right.order);

  return {
    roster,
    revision,
    enabled: (id) => enabledIds.has(id),
    pluginTitle: (id) => titles.get(id) ?? null,
    panels,
    sections,
    elements,
    routes,
    tools,
  };
}

const CompositionContext = createContext<WebComposition | null>(null);
/**
 * Kept in its OWN context, deliberately: the attach function is stable for the provider's
 * lifetime, while the composition changes with every roster. A component that subscribes a
 * socket must not re-subscribe just because a plugin was toggled.
 */
const PluginsAttachContext = createContext<((client: SessionClient) => () => void) | null>(null);

/** Throws rather than degrading: a composition-less consumer would silently render nothing. */
export function useComposition(): WebComposition {
  const composition = useContext(CompositionContext);
  if (composition === null) {
    throw new Error("useComposition requires a <CompositionProvider> ancestor");
  }
  return composition;
}

/**
 * Hands the live roster feed to whoever owns a session socket (the shell). Calling it
 * subscribes the pool's connection-level `plugins` frame; the returned function detaches.
 * Without a socket the boot fetch remains the whole truth — a roster is never a client's
 * private guess, so there is no local fallback beyond "what the server last said".
 */
export function useAttachPluginsClient(): (client: SessionClient) => () => void {
  const attach = useContext(PluginsAttachContext);
  if (attach === null) {
    throw new Error("useAttachPluginsClient requires a <CompositionProvider> ancestor");
  }
  return attach;
}

interface CompositionProviderProps {
  readonly identity: StoredIdentity;
  readonly children: ReactNode;
}

/** Roster plus revision as one unit, so a change can never bump only half of it. */
interface RosterState {
  readonly roster: PluginRoster;
  readonly revision: number;
  /** Serialized form of `roster`, so a replayed identical roster is not a "change". */
  readonly digest: string;
}

const INITIAL_ROSTER: RosterState = { roster: [], revision: 0, digest: "" };

/**
 * Owns the roster for the authenticated session: fetched once at boot (this is why the
 * provider needs the token, and why it mounts inside `IdentityGate`), then kept current by
 * whoever attaches a session client.
 */
export function CompositionProvider({
  identity,
  children,
}: CompositionProviderProps): ReactElement {
  const [state, setState] = useState<RosterState>(INITIAL_ROSTER);

  const publish = useCallback((roster: PluginRoster): void => {
    const digest = JSON.stringify(roster);
    setState((previous) =>
      previous.digest === digest ? previous : { roster, revision: previous.revision + 1, digest },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const response = await fetch("/api/plugins", {
          headers: { Authorization: `Bearer ${identity.token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`plugin roster fetch failed (${response.status})`);
        publish(PluginsResponseSchema.parse(await response.json()).plugins);
      } catch (reason) {
        if (controller.signal.aborted) return;
        // No toast layer exists above this provider, and a missing roster is already visible
        // as named placeholders where panels should be — so the console is the honest report.
        console.error("evt=plugin_roster_fetch_failed", reason);
      }
    })();
    return () => controller.abort();
  }, [identity.token, publish]);

  const attachPluginsClient = useCallback(
    (client: SessionClient): (() => void) => client.onPlugins(publish),
    [publish],
  );

  const composition = useMemo(
    () => buildWebComposition(state.roster, state.revision, WEB_PLUGIN_DEFS),
    [state],
  );

  return (
    <PluginsAttachContext.Provider value={attachPluginsClient}>
      <CompositionContext.Provider value={composition}>{children}</CompositionContext.Provider>
    </PluginsAttachContext.Provider>
  );
}

const HostServicesContext = createContext<HostServices | null>(null);

interface HostServicesProviderProps {
  readonly value: HostServices;
  readonly children: ReactNode;
}

/** Publishes the one host surface plugin code is allowed to touch (`@manifold/plugin`). */
export function HostServicesProvider({ value, children }: HostServicesProviderProps): ReactElement {
  return <HostServicesContext.Provider value={value}>{children}</HostServicesContext.Provider>;
}

/** Throws: a contribution rendered outside the host has no legal way to reach the server. */
export function useHostServices(): HostServices {
  const host = useContext(HostServicesContext);
  if (host === null) {
    throw new Error("useHostServices requires a <HostServicesProvider> ancestor");
  }
  return host;
}

/**
 * Registration channels for the two facets only the MOUNTED pad view can answer. Each is
 * its own context for the same reason the plugins attach is: the register function is stable
 * for the gate's lifetime, while the host value changes whenever a facet arrives, and a
 * renderer must not re-register because a plugin was toggled.
 */
const ViewportRegisterContext = createContext<((handle: PadViewportHandle | null) => void) | null>(
  null,
);
const AuthoringRegisterContext = createContext<
  ((handle: PadAuthoringHandle | null) => void) | null
>(null);

/**
 * Publishes the mounted pad view's viewport into the host. The pad renderer calls this with
 * its handle on mount and `null` on unmount; a spotlight arriving while no view is mounted
 * therefore finds `host.viewport === null` and says so, rather than moving a view that is
 * not there.
 */
export function useViewportRegistration(): (handle: PadViewportHandle | null) => void {
  const register = useContext(ViewportRegisterContext);
  if (register === null) {
    throw new Error("useViewportRegistration requires a <HostServicesGate> ancestor");
  }
  return register;
}

/** The same channel for the authoring door — see {@link PadAuthoringHandle}. */
export function useAuthoringRegistration(): (handle: PadAuthoringHandle | null) => void {
  const register = useContext(AuthoringRegisterContext);
  if (register === null) {
    throw new Error("useAuthoringRegistration requires a <HostServicesGate> ancestor");
  }
  return register;
}

export interface HostServicesGateProps {
  readonly identity: StoredIdentity;
  /** The application's own navigation; the gate translates `manifold://` into it. */
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
  /**
   * The routed container, when the route names one. It decides only whether the gate's
   * client JOINS a room — which is what makes `selfCaps()` answer and the roster arrive
   * live. Every HTTP door works either way.
   */
  readonly padId?: string | null;
  readonly children: ReactNode;
}

/**
 * Builds THE host surface and mounts it above every route — deliberately above, because a
 * plugin route (`/uri/<encoded>`) is a contribution too and must reach the same doors the
 * sidebar's sections do.
 *
 * Its session client is a SPECTATOR on the routed room: the gate watches, it never occupies.
 * That is what a workspace-level handle has to be — it must not fake an occupant avatar in a
 * room whose renderer already joined as one — and it is the reason `selfCaps()` and the
 * connection-level `plugins` frame reach plugin code at all. With no route to a container
 * (an empty workspace) the client stays unconnected: the HTTP doors still answer, and
 * `selfCaps()` is empty until a view exists, which reads correctly as "no view, no room".
 */
export function HostServicesGate({
  identity,
  navigate,
  padId = null,
  children,
}: HostServicesGateProps): ReactElement {
  const composition = useComposition();
  const attachPluginsClient = useAttachPluginsClient();
  const [viewport, setViewport] = useState<PadViewportHandle | null>(null);
  const [authoring, setAuthoring] = useState<PadAuthoringHandle | null>(null);

  const client = useMemo(
    () =>
      new SessionClient({
        url: sessionUrl(),
        // The workspace is not a room. Unjoined, this is the id nothing is addressed by;
        // it never reaches the wire, because an unconnected client sends no join.
        padId: padId ?? "",
        token: identity.token,
        ...(padId === null ? {} : { spectator: true }),
      }),
    [identity.token, padId],
  );

  useEffect(() => {
    if (padId === null) return;
    void client.connect().catch((reason: unknown) => {
      // The renderer's own occupant socket reports room failures to the operator; this
      // handle failing only costs the workspace its live vocabulary, so it stays quiet.
      console.error("evt=host_services_join_failed", reason);
    });
    return () => client.close();
  }, [client, padId]);

  useEffect(() => attachPluginsClient(client), [attachPluginsClient, client]);

  /**
   * One navigation door for plugin code, addressed the way the axioms address everything:
   * a `manifold://` reference, or a plain application path for the routes the browser owns.
   * A reference this shell cannot show as a route (a principal, a plugin, an action) is not
   * silently swallowed — it goes to the deep-link route, whose job is exactly that.
   */
  const navigateUri = useCallback(
    (uri: string): void => {
      if (!uri.startsWith(MANIFOLD_URI_SCHEME)) {
        navigate(uri);
        return;
      }
      const ref = parseManifoldUri(uri);
      if (ref === null) return;
      navigate(
        ref.kind === "pad" || ref.kind === "element" || ref.kind === "tile"
          ? `/p/${encodeURIComponent(ref.padId)}`
          : `/uri/${encodeURIComponent(uri)}`,
      );
    },
    [navigate],
  );

  const host = useMemo<HostServices>(
    () => ({
      client,
      padId,
      navigate: navigateUri,
      viewport,
      authoring,
      composition: {
        roster: () => composition.roster,
        enabled: (id) => composition.enabled(id),
      },
    }),
    [authoring, client, composition, navigateUri, padId, viewport],
  );

  return (
    <ViewportRegisterContext.Provider value={setViewport}>
      <AuthoringRegisterContext.Provider value={setAuthoring}>
        <HostServicesProvider value={host}>{children}</HostServicesProvider>
      </AuthoringRegisterContext.Provider>
    </ViewportRegisterContext.Provider>
  );
}

/** Why a contribution is inert. Mirrored into `data-plugin-state` for gate assertions. */
export type PlaceholderState = "disabled" | "unknown" | "unavailable";

const PLACEHOLDER_LABELS: Readonly<Record<PlaceholderState, string>> = {
  disabled: "disabled",
  unknown: "unknown plugin",
  unavailable: "no renderer",
};

export interface PluginPlaceholderProps {
  /** What to name: a plugin title when one is known, the raw contribution id otherwise. */
  readonly name: string;
  readonly state: PlaceholderState;
  /** When given, the placeholder offers to remove itself from the surface that hosts it. */
  readonly onRemove?: (() => void) | undefined;
}

/**
 * The one inert-contribution surface, shared by workspace panes and canvas nodes: it NAMES
 * what is missing, so a disabled plugin reads as "core.draw is off", never as a blank box.
 * The remove control commits a pruned workspace tree through `core.layout.set`, which is why
 * a disable can never brick a layout (D4, `[R: layout-lock blocker]`).
 */
export function PluginPlaceholder({ name, state, onRemove }: PluginPlaceholderProps): ReactElement {
  return (
    <div className="plugin-placeholder" data-plugin-state={state}>
      <strong className="plugin-placeholder__name">{name}</strong>
      <span className="plugin-placeholder__state">{PLACEHOLDER_LABELS[state]}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          className="plugin-placeholder__remove"
          data-action="core.layout.set"
          onClick={onRemove}
        >
          Remove
        </button>
      )}
    </div>
  );
}

export interface PanelOutletProps {
  /** FULL panel id, exactly as a `panel` tile surface carries it. */
  readonly panelId: string;
  /** Offered on placeholders only: prune this leaf from the caller's own layout. */
  readonly onRemove?: (() => void) | undefined;
}

/**
 * Renders whatever a `panel` tile surface points at — the single seam between the tile tree
 * and plugin code. Every failure mode is a named placeholder rather than an empty pane:
 * unknown id, known-but-disabled plugin, or a declared panel whose web half is absent.
 */
export function PanelOutlet({ panelId, onRemove }: PanelOutletProps): ReactElement {
  const composition = useComposition();
  const host = useHostServices();
  const panel = composition.panels.get(panelId);

  if (panel === undefined) {
    return <PluginPlaceholder name={panelId} state="unknown" onRemove={onRemove} />;
  }
  const name = composition.pluginTitle(panel.plugin) ?? panel.plugin;
  if (!panel.enabled) {
    return <PluginPlaceholder name={name} state="disabled" onRemove={onRemove} />;
  }
  if (panel.Component === null) {
    return <PluginPlaceholder name={name} state="unavailable" onRemove={onRemove} />;
  }
  const Panel = panel.Component;
  return <Panel host={host} />;
}
