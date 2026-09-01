import {
  OVERLAY_SLOTS,
  WORKSPACE_OVERLAY_SLOTS,
  ProjectionProvider,
  ViewportRegistrationProvider,
  sessionUrl,
  type ContainerOverlayProps,
  type OverlayRegistrations,
  type OverlaySlot,
  type WorkspaceOverlayProps,
  type WorkspaceOverlayRegistrations,
  type WorkspaceOverlaySlot,
  type ContainerRendererProps,
  type ProjectionPlaceholderProps,
  type ProjectionRegistry,
  type ProjectionState,
  type RegisteredElement,
  type RegisteredRenderer,
  type RegisteredTool,
  type TerminalFacet,
} from "@manifold/plugin/hooks";
import {
  AssemblyError,
  claim,
  composeBindings,
  reportDuplicates,
  ENGINE_SET_ENABLED_ACTION,
  type BindingSource,
  type Claims,
  type ComposedBinding,
  type ComposedPanel,
  type ComposedSection,
  type WebBinding,
  type HostServices,
  type AuthoringHandle,
  type TileGeometryHandle,
  type ViewportHandle,
  type PanelProps,
  type SectionProps,
} from "@manifold/plugin";
import {
  BindingsResponseSchema,
  DEFAULT_SECTION_PRESENTATION,
  DEFAULT_TOOLBAR,
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
import { Cover, Stack } from "@manifold/plugin/ui";
import { dispatchAction, type StoredIdentity } from "./api.ts";
import { ContainerErrorBoundary } from "./error-boundary.tsx";
import { FEED_TOPICS, WEB_PLUGIN_DEFS } from "./assembly.ts";

/**
 * The browser half of the plugin engine — FLOOR (REGISTRY.md §Foundation), which is why this
 * file never imports a plugin package: `assembly.ts` is the one web file allowed to name
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
 * One plugin's browser registrations, keyed by the LOCAL contribution name its manifest
 * declared (`sidebar`, not `core.shell.sidebar`) — except `elements`, which are keyed by the
 * wire element type, because that string is what a scene document actually stores.
 *
 * `elements` are typed as opaque components even though the element contract IS published
 * (`@manifold/plugin`'s `ElementProps`): a renderer declares only its identity and its stored
 * `data`, while each MOUNT SITE hands it whatever its own frame demands — React Flow node
 * props on a canvas, a plain render in a tile leaf. Keeping the registry opaque is what stops
 * one frame's props from becoming the contract.
 *
 * THREE of these channels have no manifest counterpart — `renderers`, the two `overlays`
 * kinds and `terminals` — and they share one rationale: none of them is a ref the WORKSPACE
 * composes, so there is nothing for a principal's layout or the sidebar order to name. A
 * container ref, an overlay and the terminal viewer are projections one renderer asks another
 * plugin for (`@manifold/plugin/hooks`' {@link ProjectionRegistry}), keyed by a CLOSED
 * vocabulary the engine owns — a discipline, a slot — rather than by a word an author picks.
 * `routes` is the exception and always was one: a path segment is a name its author invents
 * in a space every plugin shares, so it is DECLARED (`RouteDefSchema`) and this channel only
 * says who draws it, exactly as `panels` and `elements` do.
 *
 * What every one of them now shares is the refusal: a duplicate key names both offenders
 * (`buildBrowserAssembly`), because a channel whose second registrant silently wins is a
 * channel where the winner is whoever the roster happened to order last. The roster still
 * decides whether the registering plugin is ENABLED, which is what keeps every one of them
 * painting the engine's named placeholder instead of disappearing.
 */
export interface WebPluginDef {
  readonly id: string;
  readonly panels?: Readonly<Record<string, ComponentType<PanelProps>>>;
  readonly sections?: Readonly<Record<string, ComponentType<SectionProps>>>;
  readonly elements?: Readonly<Record<string, ComponentType<never>>>;
  /**
   * Who draws a URL space this plugin's manifest CLAIMED, keyed by that claim's first path
   * segment (`uri` serves `/uri/<rest>`). A key the manifest's `contributes.routes` does not
   * declare contributes nothing, and a declared segment with no key here renders the engine's
   * placeholder — the same two answers `panels` gets.
   */
  readonly routes?: Readonly<Record<string, ComponentType<{ rest: string; host: HostServices }>>>;
  /**
   * Container renderers, keyed by the container DISCIPLINE they draw (`Container["discipline"]`:
   * `canvas`, `composition`). The routed shell and every nesting renderer project a container through
   * this one registry, which is how a canvas holds a composition and a composition holds a
   * canvas without either plugin importing the other.
   */
  readonly renderers?: Readonly<Record<string, ComponentType<ContainerRendererProps>>>;
  /**
   * Decoration painted over a mounted container ref, keyed by slot. The key type is the closed
   * `OverlaySlot` vocabulary, not `string`: the registrant and the `ContainerOverlayOutlet`
   * that mounts it never import each other, and an unregistered overlay paints NOTHING, so a
   * typo on either side of a `string` key would compile clean and simply never appear. An
   * unregistered or disabled overlay still paints nothing — an inert box floating over
   * someone's canvas is worse than the missing decoration — but now only for declared slots.
   */
  readonly overlays?: OverlayRegistrations;
  /**
   * Decoration painted over the WORKSPACE, keyed by slot — the same kind one host up, on the
   * same closed-vocabulary and paint-nothing-when-absent policy (`WorkspaceOverlayOutlet`).
   * What lands here is chrome with no container to hang on: a pointer-following inspector
   * chip that has to name the sidebar row under it, and the arrange toolbar, which is about
   * the arrangement of the workspace rather than about anything inside a room.
   */
  readonly workspaceOverlays?: WorkspaceOverlayRegistrations;
  /**
   * Terminals, as every ref that paints one sees them: the viewer plus the machine
   * choice a new terminal is born on. One registration, because both belong to whichever
   * plugin owns terminals, and a ref needs both to offer the affordance honestly.
   */
  readonly terminals?: TerminalFacet;
  /**
   * The keys this plugin claims, declaration and handler together. No manifest counterpart,
   * and for a distinct reason: a key is not a ref the WORKSPACE composes and not a closed
   * vocabulary either — it is a name claimed GLOBALLY out of a space the whole keyboard
   * shares, and the composition refuses two plugins that want one key naming both (D5). See
   * `@manifold/plugin`'s `BindingDef`.
   */
  readonly bindings?: readonly WebBinding[];
}

/** A declared panel, keyed in the composition by its FULL id (`core.shell.sidebar`). */
export interface WebPanel {
  readonly plugin: string;
  readonly title: string;
  /**
   * What this panel calls the arrangement it holds INSIDE itself, when its manifest declared
   * one (`PanelDefSchema.arranges`). Undefined ≡ nothing in there to arrange. This is the
   * ONLY thing the floor knows about an inner arrangement: arrange mode offers a zoom-in
   * control for panels that carry it, labelled with this title, and learns nothing else — a
   * floor that enumerated arrangeable panels would be a floor naming plugins.
   */
  readonly arranges?: { readonly title: string } | undefined;
  /** Null when the plugin declared the panel but registered no component. */
  readonly Component: ComponentType<PanelProps> | null;
  readonly enabled: boolean;
}

/**
 * A declared sidebar section, with its browser attachment. Section ids are global (one
 * sidebar, one slot per name).
 *
 * It EXTENDS the row `host.assembly` publishes rather than restating those fields: the rows a
 * plugin reads and the rows this file resolves components for are one registry seen twice
 * (invariant 14), and only the extra member — who draws it — is the browser's own.
 */
export interface WebSection extends ComposedSection {
  /** Null when the plugin declared the section and registered no component. */
  readonly Component: ComponentType<SectionProps> | null;
}

/**
 * A declared URL space, keyed in the composition by the first path segment its manifest
 * claimed (`RouteDefSchema`). `plugin` is the claimant and `enabled` is that plugin's roster
 * state, so a disabled deep link is a named placeholder rather than a dead end.
 */
export interface WebRoute {
  readonly plugin: string;
  /** Null when the manifest claimed the segment and the web half registered no component. */
  readonly Component: ComponentType<{ rest: string; host: HostServices }> | null;
  readonly enabled: boolean;
}

/** What a plugin registered for the terminal projection, plus its roster state. */
export interface WebTerminals {
  readonly plugin: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly facet: TerminalFacet;
}

/**
 * The browser's view of the composition: the roster plus one registry per contribution kind,
 * with components attached. `revision` increments on every roster change, so anything that
 * must be rebuilt when the vocabulary moves (React Flow's node-type map, for one) has a
 * cheap memo key instead of a deep comparison.
 *
 * Four of the registries below are typed by `@manifold/plugin` rather than by this file
 * ({@link RegisteredElement}, {@link RegisteredTool}, {@link RegisteredRenderer}): they are
 * exactly what the projection registry publishes to plugin code, and a second shape for the
 * same row would be a second answer to "what did the composition register" (invariant 14).
 */
export interface BrowserAssembly {
  readonly roster: PluginRoster;
  readonly revision: number;
  /** False for a disabled plugin AND for an id the roster does not carry. */
  enabled(id: string): boolean;
  /** The plugin's human title, for placeholders and admin UI; null when unknown. */
  pluginTitle(id: string): string | null;
  /** Keyed by FULL panel id — the id a `panel` tile ref names. */
  readonly panels: ReadonlyMap<string, WebPanel>;
  /** Sorted by declared `order`; ties keep roster order. */
  readonly sections: readonly WebSection[];
  readonly elements: ReadonlyMap<string, RegisteredElement>;
  /** Keyed by the claimed first path segment; a segment no manifest claimed is absent. */
  readonly routes: ReadonlyMap<string, WebRoute>;
  readonly tools: readonly RegisteredTool[];
  /** Keyed by container discipline (`canvas`, `composition`). */
  readonly renderers: ReadonlyMap<string, RegisteredRenderer<ContainerRendererProps>>;
  /** Keyed by overlay slot; only declared slots can appear. */
  readonly overlays: ReadonlyMap<OverlaySlot, RegisteredRenderer<ContainerOverlayProps>>;
  /** Keyed by workspace overlay slot; only declared slots can appear. */
  readonly workspaceOverlays: ReadonlyMap<
    WorkspaceOverlaySlot,
    RegisteredRenderer<WorkspaceOverlayProps>
  >;
  /** Null until some enabled-or-disabled plugin registers the terminal facet. */
  readonly terminals: WebTerminals | null;
  /**
   * The composed key table, sorted by key, carrying EFFECTIVE keys: the vocabulary the host
   * dispatches and the editor prints, with this principal's rebindings already applied and each
   * row's declared key beside it. A DISABLED plugin's rows are absent rather than tagged — the
   * one registry here that drops instead of marking, because a keystroke has no place to paint
   * an absence on (`composeBindings`).
   */
  readonly bindings: readonly ComposedBinding[];
  /**
   * The delta the table above was composed with, as binding id → key: this principal's stored
   * rebindings, fetched from `GET /api/bindings` at boot and re-read whenever a door writes one.
   * Published so an editor can tell a rebound row from a declared one, and see an override that
   * lost a contested key.
   */
  readonly bindingOverrides: Readonly<Record<string, string>>;
}

/**
 * Joins the server's vocabulary with the browser's registrations. Pure, and exported so the
 * join is testable without a provider or a socket.
 *
 * `overrides` is this principal's stored rebindings, handed in rather than fetched here for the
 * reason the roster is: this function is a JOIN over data somebody else owns the lifetime of.
 * It reaches exactly one consumer — `composeBindings`, the one seam effective keys exist at.
 */
export function buildBrowserAssembly(
  roster: PluginRoster,
  revision: number,
  defs: readonly WebPluginDef[],
  overrides: Readonly<Record<string, string>> = {},
): BrowserAssembly {
  const byId = new Map(defs.map((def) => [def.id, def]));
  const titles = new Map<string, string>();
  const enabledIds = new Set<string>();
  const panels = new Map<string, WebPanel>();
  const sections: WebSection[] = [];
  const elements = new Map<string, RegisteredElement>();
  const tools: RegisteredTool[] = [];
  const routes = new Map<string, WebRoute>();
  const renderers = new Map<string, RegisteredRenderer<ContainerRendererProps>>();
  const overlays = new Map<OverlaySlot, RegisteredRenderer<ContainerOverlayProps>>();
  const workspaceOverlays = new Map<
    WorkspaceOverlaySlot,
    RegisteredRenderer<WorkspaceOverlayProps>
  >();
  let terminals: WebTerminals | null = null;
  const bindingSources: BindingSource[] = [];
  /*
    WHO CLAIMED WHAT, for the channels this join owns the vocabulary of. The engine's own
    `Claims` type and reporter, deliberately, rather than a browser-local check: "two plugins
    claimed one thing" is one sentence in this system, wherever it is raised (`reportDuplicates`,
    `@manifold/plugin`).
   */
  const routeSegments: Claims = new Map();
  const rendererDisciplines: Claims = new Map();
  const overlaySlots: Claims = new Map();
  const workspaceOverlaySlots: Claims = new Map();
  const terminalFacets: Claims = new Map();

  for (const entry of roster) {
    const { manifest, enabled } = entry;
    const def = byId.get(manifest.id);
    titles.set(manifest.id, manifest.title);
    if (enabled) enabledIds.add(manifest.id);

    for (const panel of manifest.contributes.panels) {
      panels.set(`${manifest.id}.${panel.id}`, {
        plugin: manifest.id,
        title: panel.title,
        arranges: panel.arranges,
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
        // Carried verbatim, and spread because absence is a MEANING here: a row with no word is
        // its own painted unit (`clusteredSections`).
        ...(section.cluster === undefined ? {} : { cluster: section.cluster }),
        /*
          RESOLVED here, exactly as `assembleRoster` resolves it server-side: a manifest that
          declares nothing yields the default, so no reader downstream has to know what the
          default is (`AssemblySection.presentation`).
        */
        presentation: section.presentation ?? DEFAULT_SECTION_PRESENTATION,
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
        toolbar: tool.toolbar ?? DEFAULT_TOOLBAR,
        enabled,
      });
    }
    /*
      ROUTES are the one of these channels with a manifest row (`RouteDefSchema`), so they
      read exactly as panels and elements do: the DECLARATION is the vocabulary, the
      registration only says who draws it, and a component for a segment this manifest never
      claimed contributes nothing. `enabled` is the registering plugin's own, which is what
      keeps a disabled plugin's deep link rendering a named placeholder instead of a dead end.
     */
    for (const route of manifest.contributes.routes ?? []) {
      claim(routeSegments, route.segment, manifest.id);
      routes.set(route.segment, {
        plugin: manifest.id,
        Component: def?.routes?.[route.segment] ?? null,
        enabled,
      });
    }
    /*
      The PROJECTION channels, and the reason they read differently from `routes`: a
      registration with no manifest row still belongs to a plugin, so it inherits that
      plugin's roster state and paints the engine's placeholder (or, for an overlay, nothing)
      the moment the plugin is disabled. `title` is the plugin's own, because that is what a
      placeholder must name — the missing renderer has no title of its own to borrow.

      Every key is CLAIMED as it is registered, and the claims are ruled on after the roster
      (`reportDuplicates`, below): a registration-time channel with no manifest row still owes
      D5 its refusal, and until this loop collected claims the second registrant of a
      discipline or a slot silently won by roster order.
     */
    for (const [discipline, Component] of Object.entries(def?.renderers ?? {})) {
      claim(rendererDisciplines, discipline, manifest.id);
      renderers.set(discipline, {
        plugin: manifest.id,
        title: manifest.title,
        Component,
        enabled,
      });
    }
    /*
      Walked over the declared slot vocabulary rather than over the registration's own keys:
      `Object.entries` widens the key back to `string`, which is the exact typing this join was
      losing. Iterating OVERLAY_SLOTS keeps the key type and needs no cast.
     */
    for (const slot of OVERLAY_SLOTS) {
      const Component = def?.overlays?.[slot];
      if (Component === undefined) continue;
      claim(overlaySlots, slot, manifest.id);
      overlays.set(slot, { plugin: manifest.id, title: manifest.title, Component, enabled });
    }
    for (const slot of WORKSPACE_OVERLAY_SLOTS) {
      const Component = def?.workspaceOverlays?.[slot];
      if (Component === undefined) continue;
      claim(workspaceOverlaySlots, slot, manifest.id);
      workspaceOverlays.set(slot, {
        plugin: manifest.id,
        title: manifest.title,
        Component,
        enabled,
      });
    }
    if (def?.terminals !== undefined) {
      // The facet is ONE registration for the whole workspace, so it is claimed under the
      // projection key every mount site asks for it by: two plugins publishing a terminal
      // viewer is the same event as two claiming an overlay slot, not a silent handover.
      claim(terminalFacets, "terminals", manifest.id);
      terminals = {
        plugin: manifest.id,
        title: manifest.title,
        enabled,
        facet: def.terminals,
      };
    }
    /*
      Bindings are collected rather than resolved here: the collision rules are the engine's
      (`composeBindings`), including the one this loop could not enforce — a key claimed by a
      DISABLED plugin still collides, so toggling a plugin off can never hide a clash that
      toggling it back on resurrects.
     */
    if (def?.bindings !== undefined) {
      bindingSources.push({ plugin: manifest.id, enabled, bindings: def.bindings });
    }
  }

  /*
    THE REFUSAL, in the engine's own words and for the engine's own reason: a name two plugins
    claimed is an authoring bug, and the answer is both offenders rather than a winner whose
    identity depends on registration order (`AssemblyError`). These five channels are checked
    HERE because the server never sees them — a renderer, an overlay slot and the terminal
    facet are browser registrations, and a route's manifest row is re-checked for the reason
    `assembleRoster` is re-runnable at all: the browser composes a roster too.

    Claims come from the WHOLE roster, disabled entries included, exactly as `assembleRoster`
    checks names: turning a plugin off may never mask a collision that turning it back on
    would resurrect.
   */
  const problems: string[] = [];
  reportDuplicates(routeSegments, "route", problems);
  reportDuplicates(rendererDisciplines, "renderer", problems);
  reportDuplicates(overlaySlots, "overlay", problems);
  reportDuplicates(workspaceOverlaySlots, "workspace overlay", problems);
  reportDuplicates(terminalFacets, "facet", problems);
  if (problems.length > 0) throw new AssemblyError(problems);

  // Array#sort is stable, so equal orders keep the roster's own order — the same tiebreak
  // the engine's `assembleRoster` applies server-side.
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
    renderers,
    overlays,
    workspaceOverlays,
    bindings: composeBindings(bindingSources, overrides),
    bindingOverrides: overrides,
    terminals,
  };
}

const AssemblyContext = createContext<BrowserAssembly | null>(null);
/**
 * Kept in its OWN context, deliberately: the attach function is stable for the provider's
 * lifetime, while the composition changes with every roster. A component that subscribes a
 * socket must not re-subscribe just because a plugin was toggled.
 */
const PluginsAttachContext = createContext<((client: SessionClient) => () => void) | null>(null);
/**
 * The engine's own re-read of this principal's key overrides, in its own context for the same
 * reason the attach channel is in one: it is stable for the provider's lifetime while the
 * composition changes with every roster. A plugin whose door just wrote a rebinding calls it
 * through `host.assembly.refreshBindings`, so the writer says "your copy is stale" without
 * either side importing the other.
 */
const BindingsRefreshContext = createContext<(() => void) | null>(null);

/** Throws rather than degrading: an assembly-less consumer would silently render nothing. */
export function useAssembly(): BrowserAssembly {
  const assembly = useContext(AssemblyContext);
  if (assembly === null) {
    throw new Error("useAssembly requires a <AssemblyProvider> ancestor");
  }
  return assembly;
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
    throw new Error("useAttachPluginsClient requires a <AssemblyProvider> ancestor");
  }
  return attach;
}

/** Throws for the reason `useAssembly` does: a silent no-op would look like a saved rebinding. */
export function useRefreshBindings(): () => void {
  const refresh = useContext(BindingsRefreshContext);
  if (refresh === null) {
    throw new Error("useRefreshBindings requires a <AssemblyProvider> ancestor");
  }
  return refresh;
}

interface AssemblyProviderProps {
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
 * THE BOOT RECOVERY: an assembly with essential seats switched off, and the one-click offer to
 * put them back.
 *
 * WHY IT IS FLOOR, and why it is here rather than in a plugin, is the bootstrap-circularity
 * criterion of AXIOMS.md §Foundation law applied literally. The state this screen exists for is
 * a workspace whose non-negotiable seats are off — no brand line, no key table, no plugin
 * ledger — so a plugin-hosted recovery would be a recovery key riding the broken system: the
 * seat holding it could be the seat that is off. The engine composed the assembly, so the engine
 * makes the offer, and it makes it before the workspace paints.
 *
 * IT IS ALSO UNREACHABLE BY DESIGN. The engine's own door refuses to disable an essential
 * plugin (`refusal: "essential"`), so this state cannot be produced through the product at all —
 * only out of band, by editing the disabled set in SQLite or by a shipped seat losing its
 * `essential` flag between releases. That is exactly why it needs a WAY OUT rather than a
 * warning: an operator who reached it has no in-product lever left.
 *
 * RESTORE MEANS THE DEFAULT COMPOSITION, and the default is "every shipped seat on" — the
 * disabled set starts empty, so restoring it is enabling every `builtin`-sourced row that is
 * off. It goes through `engine.plugins.setEnabled`, one dispatch per row, so every re-enable is
 * traced by the ladder like any other exercise of authority (axiom A6) instead of being a
 * privileged bulk write with no record.
 */
function EssentialRecovery({
  identity,
  roster,
  onRestored,
  children,
}: {
  readonly identity: StoredIdentity;
  readonly roster: PluginRoster;
  readonly onRestored: (roster: PluginRoster) => void;
  readonly children: ReactNode;
}): ReactElement {
  const [restoring, setRestoring] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const missing = roster.filter((entry) => entry.manifest.essential === true && !entry.enabled);
  if (missing.length === 0) return <>{children}</>;

  const restore = async (): Promise<void> => {
    setRestoring(true);
    setFailure(null);
    try {
      /*
        EVERY ROW THAT IS OFF, because the default composition is "nothing disabled" — the
        disabled set starts empty and this puts it back. Filtering by `source` was the first
        shape of this and it was wrong twice over: `builtin` is the ENGINE's own published
        doors, not the shipped seats, so the pass enabled nothing at all and re-rendered the
        same screen. The roster IS the distribution today (plugin code that manifold did not
        compile in is the marketplace wave, AXIOMS.md §Roadmap), so "every row" and "every
        shipped row" name the same set; when that stops being true this needs the shipped set,
        not a guess about `source`.

        Sequential rather than fanned out: enablement is workspace-global and each transition
        runs the roster's lifecycle hooks, so two in flight would race the composition they both
        change. A handful of rows is a handful of round trips.
      */
      for (const entry of roster) {
        if (entry.enabled) continue;
        await dispatchAction(identity.token, ENGINE_SET_ENABLED_ACTION, {
          id: entry.manifest.id,
          enabled: true,
        });
      }
      const response = await fetch("/api/plugins", {
        headers: { Authorization: `Bearer ${identity.token}` },
      });
      if (!response.ok) throw new Error(`plugin roster fetch failed (${response.status})`);
      onRestored(PluginsResponseSchema.parse(await response.json()).plugins);
    } catch (reason: unknown) {
      setFailure(
        reason instanceof Error ? reason.message : "Could not restore the default plugins",
      );
    } finally {
      setRestoring(false);
    }
  };

  return (
    <main className="gate-screen">
      <Cover className="gate-cover">
        <section className="gate-card" aria-labelledby="essential-recovery-title">
          <p className="eyebrow">manifold</p>
          <h1 id="essential-recovery-title">This workspace is missing essential plugins</h1>
          <p>
            {missing.map((entry) => entry.manifest.title).join(", ")}{" "}
            {missing.length === 1 ? "is" : "are"} switched off. The workspace cannot draw itself
            without them, and nothing in the product can turn them off — so this assembly was
            changed outside it.
          </p>
          {failure === null ? null : <p className="form-error">{failure}</p>}
          <button
            className="primary-button"
            data-action={ENGINE_SET_ENABLED_ACTION}
            data-testid="essential-restore"
            type="button"
            disabled={restoring}
            onClick={() => void restore()}
          >
            {restoring ? "Restoring default plugins…" : "Restore default plugins"}
          </button>
        </section>
      </Cover>
    </main>
  );
}

/**
 * Owns the roster and this principal's key overrides for the authenticated terminal: both
 * fetched once at boot (this is why the provider needs the token, and why it mounts inside
 * `IdentityGate`), the roster then kept current by whoever attaches a session client and the
 * overrides re-read on demand when a door writes one.
 *
 * IT ALSO OWNS THE BOOT RECOVERY, and that is the bootstrap-circularity criterion rather than a
 * convenience: an assembly with essential seats switched off cannot host the affordance that
 * turns them back on, so the offer has to come from the floor that composed it, before the
 * workspace paints (see {@link EssentialRecovery}).
 */
export function AssemblyProvider({ identity, children }: AssemblyProviderProps): ReactElement {
  const [state, setState] = useState<RosterState>(INITIAL_ROSTER);
  const [overrides, setOverrides] = useState<Readonly<Record<string, string>>>({});
  /** Bumped to ask for a fresh read; the effect below is keyed on it. */
  const [overridesEpoch, setOverridesEpoch] = useState(0);

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
        // No notice layer exists above this provider, and a missing roster is already visible
        // as named placeholders where panels should be — so the console is the honest report.
        console.error("evt=plugin_roster_fetch_failed", reason);
      }
    })();
    return () => controller.abort();
  }, [identity.token, publish]);

  /*
    THE KEY DELTA, read from the neutral route (`GET /api/bindings`) rather than by dispatching
    the door that writes it: the engine composes the key table before any plugin has drawn
    anything, and a floor file that fetched it through `core.keys` would be the floor naming a
    favourite plugin. A failed read composes the DECLARED keys, which is the honest degradation —
    every key answers what its plugin shipped.
  */
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const response = await fetch("/api/bindings", {
          headers: { Authorization: `Bearer ${identity.token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`binding override fetch failed (${response.status})`);
        setOverrides(BindingsResponseSchema.parse(await response.json()).overrides);
      } catch (reason) {
        if (controller.signal.aborted) return;
        console.error("evt=binding_overrides_fetch_failed", reason);
      }
    })();
    return () => controller.abort();
  }, [identity.token, overridesEpoch]);

  const attachPluginsClient = useCallback(
    (client: SessionClient): (() => void) => client.onPlugins(publish),
    [publish],
  );

  const refreshBindings = useCallback((): void => {
    setOverridesEpoch((epoch) => epoch + 1);
  }, []);

  const assembly = useMemo(
    () => buildBrowserAssembly(state.roster, state.revision, WEB_PLUGIN_DEFS, overrides),
    [state, overrides],
  );

  return (
    <PluginsAttachContext.Provider value={attachPluginsClient}>
      <BindingsRefreshContext.Provider value={refreshBindings}>
        <AssemblyContext.Provider value={assembly}>
          <EssentialRecovery identity={identity} roster={state.roster} onRestored={publish}>
            {children}
          </EssentialRecovery>
        </AssemblyContext.Provider>
      </BindingsRefreshContext.Provider>
    </PluginsAttachContext.Provider>
  );
}

const HostServicesContext = createContext<HostServices | null>(null);

interface HostServicesProviderProps {
  readonly value: HostServices;
  readonly children: ReactNode;
}

/** Publishes the one host ref plugin code is allowed to touch (`@manifold/plugin`). */
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
 * The registration channel for the one facet only the MOUNTED container view can answer, and the
 * only one whose consumer is FLOOR. Its own context for the same reason the plugins attach
 * is: the register function is stable for the gate's lifetime, while the host value changes
 * whenever a facet arrives, and a renderer must not re-register because a plugin was toggled.
 *
 * The viewport's twin lives in `@manifold/plugin/hooks`
 * ({@link ViewportRegistrationProvider}) rather than here, because the renderer that
 * publishes a viewport is a plugin and a plugin may not import this file.
 */
const AuthoringRegisterContext = createContext<((handle: AuthoringHandle | null) => void) | null>(
  null,
);

/** The same channel for the authoring door — see {@link AuthoringHandle}. */
export function useAuthoringRegistration(): (handle: AuthoringHandle | null) => void {
  const register = useContext(AuthoringRegisterContext);
  if (register === null) {
    throw new Error("useAuthoringRegistration requires a <HostServicesGate> ancestor");
  }
  return register;
}

/**
 * The registration channel for {@link TileGeometryHandle} — the workspace tree's own read
 * surface, published by `workspace.tsx` the same way the authoring door is: floor state,
 * a floor renderer registers it, a plugin only ever reads it through `host.tileGeometry`.
 * `core.arrange` (issue #89) is the one consumer today.
 */
const TileGeometryRegisterContext = createContext<
  ((handle: TileGeometryHandle | null) => void) | null
>(null);

/** The same channel for the workspace tree — see {@link TileGeometryHandle}. */
export function useTileGeometryRegistration(): (handle: TileGeometryHandle | null) => void {
  const register = useContext(TileGeometryRegisterContext);
  if (register === null) {
    throw new Error("useTileGeometryRegistration requires a <HostServicesGate> ancestor");
  }
  return register;
}

/**
 * Is the keystroke going into text? Then it is typing, not dispatching. A binding may claim a
 * printable key, and one shared registry must not let that row eat a rename field's letters.
 */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * THE key dispatcher: ONE listener for every declared binding in the composition, mounted by
 * the host gate so a key answers wherever the viewer is — a route, a panel, a canvas.
 *
 * It is the whole of what the floor decides about a key: the composed table says which row owns
 * it, and the row's own handler does the work (`@manifold/plugin`'s `BindingDef` — a binding
 * carries no authority, so anything that mutates goes through a registered action). Two things
 * are refused here rather than in every handler, because both are properties of the KEY and not
 * of any plugin's behavior: a chord is a different key than the one it decorates, and typing is
 * not dispatching.
 *
 * Undeclared listeners on `window` are what this replaces. One of them (F9's) shipped in the
 * engine's own standard library, where nothing could collide with it, list it, or turn it off.
 */
function useBindingDispatch(bindings: readonly ComposedBinding[], host: HostServices): void {
  useEffect(() => {
    if (bindings.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (typingInto(event.target)) return;
      const binding = bindings.find((row) => row.key === event.key);
      if (binding === undefined) return;
      event.preventDefault();
      binding.run(host);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, host]);
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
  readonly containerId?: string | null;
  readonly children: ReactNode;
}

/**
 * Builds THE host ref and mounts it above every route — deliberately above, because a
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
  containerId = null,
  children,
}: HostServicesGateProps): ReactElement {
  const assembly = useAssembly();
  const attachPluginsClient = useAttachPluginsClient();
  /*
    The engine's re-read of this principal's rebindings, handed to plugin code as
    `host.assembly.refreshBindings`: the write is somebody's door, the read is the engine's.
  */
  const refreshBindings = useRefreshBindings();
  const [viewport, setViewport] = useState<ViewportHandle | null>(null);
  const [authoring, setAuthoring] = useState<AuthoringHandle | null>(null);
  const [tileGeometry, setTileGeometry] = useState<TileGeometryHandle | null>(null);

  const client = useMemo(
    () =>
      new SessionClient({
        url: sessionUrl(),
        // The workspace is not a room. Unjoined, this is the id nothing is addressed by;
        // it never reaches the wire, because an unconnected client sends no join.
        containerId: containerId ?? "",
        token: identity.token,
        ...(containerId === null ? {} : { spectator: true }),
      }),
    [identity.token, containerId],
  );

  useEffect(() => {
    if (containerId === null) return;
    void client.connect().catch((reason: unknown) => {
      // The renderer's own occupant socket reports room failures to the operator; this
      // handle failing only costs the workspace its live vocabulary, so it stays quiet.
      console.error("evt=host_services_join_failed", reason);
    });
    return () => client.close();
  }, [client, containerId]);

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
        ref.kind === "container" || ref.kind === "element" || ref.kind === "tile"
          ? `/p/${encodeURIComponent(ref.containerId)}`
          : `/uri/${encodeURIComponent(uri)}`,
      );
    },
    [navigate],
  );

  /**
   * THE SECTION ROWS AS PLUGIN CODE SEES THEM: the composition's rows with the browser's own
   * attachment PROJECTED OFF, so `host.assembly` carries no component reference at all.
   *
   * A cast would have satisfied the type and left the components reachable at runtime, which
   * is the kind of read surface that erodes: reaching a registered component belongs to
   * `SectionOutlet` and nowhere else. Once per roster change rather than per render, which is
   * what the memo key buys.
   */
  const composedSections = useMemo<readonly ComposedSection[]>(
    () =>
      assembly.sections.map(({ id, plugin, title, order, presentation, cluster, enabled }) => ({
        id,
        plugin,
        title,
        order,
        presentation,
        // Absence is a meaning (a row is its own painted unit), so it is spread rather than
        // assigned an explicit `undefined`.
        ...(cluster === undefined ? {} : { cluster }),
        enabled,
      })),
    [assembly],
  );

  /**
   * THE PANELS AS PLUGIN CODE SEES THEM, the same projection `composedSections` performs one
   * member up: `WebPanel`'s browser-only `Component` dropped, the manifest facts and the
   * roster fact kept. `core.arrange` (issue #89) is this projection's reason to exist —
   * resolving a scope and naming a grip needs a panel's title and its `arranges` declaration,
   * never the component that renders it.
   */
  const composedPanels = useMemo<ReadonlyMap<string, ComposedPanel>>(
    () =>
      new Map(
        [...assembly.panels].map(([id, { plugin, title, arranges, enabled }]) => [
          id,
          { plugin, title, ...(arranges === undefined ? {} : { arranges }), enabled },
        ]),
      ),
    [assembly],
  );

  const host = useMemo<HostServices>(
    () => ({
      client,
      principal: identity.principal,
      token: identity.token,
      containerId,
      navigate: navigateUri,
      viewport,
      authoring,
      tileGeometry,
      /*
        THE READ SURFACE onto the live composition (`AssemblyFacet`). Every member is a
        question keyed by an id the caller already holds and none of them is a lever: the
        shell's own sidebar panel reads the section rows and the key table through here, and
        so would a stranger's replacement for it.
       */
      assembly: {
        roster: () => assembly.roster,
        enabled: (id) => assembly.enabled(id),
        pluginTitle: (id) => assembly.pluginTitle(id),
        sections: composedSections,
        panels: composedPanels,
        bindings: assembly.bindings,
        bindingOverrides: assembly.bindingOverrides,
        refreshBindings,
      },
      /*
        The four collection nodes the shared feeds subscribe to, handed down from the one
        file allowed to name a plugin. A section may not spell another plugin's id either,
        so the terminal listing's topic reaches `core.index`'s sidebar section through here.
       */
      topics: FEED_TOPICS,
    }),
    [
      authoring,
      client,
      assembly,
      composedPanels,
      composedSections,
      refreshBindings,
      identity,
      navigateUri,
      containerId,
      tileGeometry,
      viewport,
    ],
  );

  /*
    The composition's keys, live: the table moves when a plugin is toggled, and dispatch follows
    it without a remount because the listener is keyed on the table itself.
  */
  useBindingDispatch(assembly.bindings, host);

  /**
   * THE PROJECTION REGISTRY, as plugin code sees it: the composition's registries plus this
   * file's own placeholder and error boundary, so every mount site in the product resolves an
   * occupant the same way, paints the same named absence, and contains a fault the same way.
   * Memoized on the composition alone — the registry carries no per-render state, so a roster
   * change is the only reason it may move (a fresh object here would rebuild React Flow's
   * node-type map and remount every live PTY).
   */
  const projection = useMemo<ProjectionRegistry>(() => {
    /*
      The section rows, INDEXED for the outlet that resolves them. Derived from the one
      `sections` array rather than joined a second time (invariant 14), and `title` is the
      OWNING PLUGIN's — a missing section component has no title of its own to borrow, which
      is the same rule the renderer and overlay channels above already follow.
     */
    const sections = new Map<string, RegisteredRenderer<SectionProps>>(
      assembly.sections.map((section) => [
        section.id,
        {
          plugin: section.plugin,
          title: assembly.pluginTitle(section.plugin) ?? section.plugin,
          enabled: section.enabled,
          Component: section.Component,
        },
      ]),
    );
    return {
      revision: assembly.revision,
      Placeholder: PluginPlaceholder,
      ErrorBoundary: ContainerErrorBoundary,
      terminals: assembly.terminals,
      renderer: (layout) => assembly.renderers.get(layout) ?? null,
      overlay: (slot) => assembly.overlays.get(slot) ?? null,
      workspaceOverlay: (slot) => assembly.workspaceOverlays.get(slot) ?? null,
      element: (type) => assembly.elements.get(type) ?? null,
      section: (id) => sections.get(id) ?? null,
      elements: assembly.elements,
      tools: assembly.tools,
    };
  }, [assembly]);

  return (
    <ViewportRegistrationProvider value={setViewport}>
      <AuthoringRegisterContext.Provider value={setAuthoring}>
        <TileGeometryRegisterContext.Provider value={setTileGeometry}>
          <ProjectionProvider value={projection}>
            <HostServicesProvider value={host}>{children}</HostServicesProvider>
          </ProjectionProvider>
        </TileGeometryRegisterContext.Provider>
      </AuthoringRegisterContext.Provider>
    </ViewportRegistrationProvider>
  );
}

/**
 * Why a contribution is inert. Mirrored into `data-plugin-state` for gate assertions, and an
 * alias rather than a copy of `@manifold/plugin`'s union: the projection registry publishes
 * these three states to plugin code, and two spellings of the same closed set is exactly the
 * drift invariant 14 forbids.
 */
export type PlaceholderState = ProjectionState;

const PLACEHOLDER_LABELS: Readonly<Record<PlaceholderState, string>> = {
  disabled: "disabled",
  unknown: "unknown plugin",
  unavailable: "no renderer",
};

export type PluginPlaceholderProps = ProjectionPlaceholderProps;

/**
 * The one inert-contribution ref, shared by workspace panes and canvas nodes: it NAMES
 * what is missing, so a disabled plugin reads as "core.draw is off", never as a blank box.
 * The remove control commits a pruned workspace tree through `core.space.setLayout`, which is why
 * a disable can never brick a layout (D4, `[R: layout-lock blocker]`).
 */
export function PluginPlaceholder({ name, state, onRemove }: PluginPlaceholderProps): ReactElement {
  return (
    <Cover className="plugin-placeholder" data-plugin-state={state}>
      <Stack gap="0.3rem" align="center">
        <strong className="plugin-placeholder__name">{name}</strong>
        <span className="plugin-placeholder__state">{PLACEHOLDER_LABELS[state]}</span>
        {onRemove === undefined ? null : (
          <button
            type="button"
            className="plugin-placeholder__remove"
            data-action="core.space.setLayout"
            onClick={onRemove}
          >
            Remove
          </button>
        )}
      </Stack>
    </Cover>
  );
}

export interface PanelOutletProps {
  /** FULL panel id, exactly as a `panel` tile ref carries it. */
  readonly panelId: string;
  /** Offered on placeholders only: prune this leaf from the caller's own layout. */
  readonly onRemove?: (() => void) | undefined;
}

/**
 * Renders whatever a `panel` tile ref points at — the single call ref between the tile tree
 * and plugin code. Every failure mode is a named placeholder rather than an empty pane:
 * unknown id, known-but-disabled plugin, or a declared panel whose web half is absent.
 */
export function PanelOutlet({ panelId, onRemove }: PanelOutletProps): ReactElement {
  const assembly = useAssembly();
  const host = useHostServices();
  const panel = assembly.panels.get(panelId);

  if (panel === undefined) {
    return <PluginPlaceholder name={panelId} state="unknown" onRemove={onRemove} />;
  }
  const name = assembly.pluginTitle(panel.plugin) ?? panel.plugin;
  if (!panel.enabled) {
    return <PluginPlaceholder name={name} state="disabled" onRemove={onRemove} />;
  }
  if (panel.Component === null) {
    return <PluginPlaceholder name={name} state="unavailable" onRemove={onRemove} />;
  }
  const Panel = panel.Component;
  return <Panel host={host} />;
}
