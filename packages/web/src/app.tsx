import { WORKSPACE_OVERLAY_SLOTS, WorkspaceOverlayOutlet } from "@manifold/plugin/hooks";
import { parseManifoldUri, ROUTE_SEGMENT_PATTERN, type ManifoldRef } from "@manifold/protocol";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { StoredIdentity } from "./api.ts";
import { WorkspaceHost } from "./workspace.tsx";
import {
  HostServicesGate,
  PluginPlaceholder,
  REQUESTED_REF_PARAM,
  useAssembly,
  useHostServices,
} from "./plugin-host.tsx";
import { NoticeProvider } from "./notice.tsx";

type Route =
  | {
      readonly kind: "browser";
      readonly containerId: string | null;
      /**
       * The address this route was asked to open ALONGSIDE the container it names, when the
       * query carries one — a plugin, shown by a surface inside the workspace rather than by
       * a route of its own. Null for every ordinary navigation, which is nearly all of them.
       */
      readonly requestedRef: ManifoldRef | null;
    }
  /**
   * A route a PLUGIN owns, addressed by its first path segment (`/uri/<rest>`). The engine
   * resolves the segment against the composition and hands the rest over verbatim: which
   * plugin answers `uri` is not knowledge this table holds.
   */
  | { readonly kind: "plugin"; readonly prefix: string; readonly rest: string }
  | { readonly kind: "not_found" };

/*
  The segment is matched as "everything up to the next slash" and then tested against the
  PROTOCOL's own claim pattern (`ROUTE_SEGMENT_PATTERN`, what a manifest's `contributes.routes`
  may declare), rather than spelling the character class a second time here. Two spellings of
  one rule is how a path a manifest may legally claim becomes a path the browser answers 404
  for (invariant 14).
 */
const PLUGIN_ROUTE = /^\/([^/]+)\/(.+)$/;

/**
 * The requested address, parsed off the query — or null, which covers "no parameter", "not a
 * legal reference" and "not a form anything answers" alike. A malformed one is DROPPED rather
 * than reported: the route it rides on is a real place and the reader is already there, so the
 * honest outcome is the workspace without the extra thing, not an error page over a page that
 * loaded fine.
 */
function requestedRef(): ManifoldRef | null {
  const raw = new URLSearchParams(window.location.search).get(REQUESTED_REF_PARAM);
  return raw === null ? null : parseManifoldUri(raw);
}

function currentRoute(): Route {
  if (window.location.pathname === "/") {
    return { kind: "browser", containerId: null, requestedRef: requestedRef() };
  }
  const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
  if (match?.[1] !== undefined) {
    try {
      return {
        kind: "browser",
        containerId: decodeURIComponent(match[1]),
        requestedRef: requestedRef(),
      };
    } catch {
      return { kind: "not_found" };
    }
  }
  // Everything else with a leading segment is offered to the composition; an unclaimed
  // prefix falls through to a named placeholder rather than a silent 404.
  const plugin = PLUGIN_ROUTE.exec(window.location.pathname);
  const segment = plugin?.[1];
  if (segment !== undefined && plugin?.[2] !== undefined && ROUTE_SEGMENT_PATTERN.test(segment)) {
    return { kind: "plugin", prefix: segment, rest: plugin[2] };
  }
  return { kind: "not_found" };
}

interface AppProps {
  readonly identity: StoredIdentity;
}

/**
 * Keeps the view shell mounted across root and direct-container routes.
 *
 * The notice layer is mounted HERE, above every route: it must outlive the shell it
 * reports for (a renderer that crashes into the error boundary still has notices to
 * show) and it must sit outside the sidebar's collapse subtree, which is what used to
 * hide sidebar failures on the icon rail.
 *
 * `HostServicesGate` sits above the route switch for the same reason: a plugin route is
 * plugin code, so it needs the one host ref (`client`, `navigate`, `viewport`) exactly
 * like a panel or a section does.
 *
 * THE WORKSPACE OVERLAY SLOTS are mounted here for the notice layer's exact two reasons.
 * A workspace overlay is chrome with no container to hang on — an inspector chip that
 * follows the pointer across the sidebar and the frame alike, the arrange toolbar — so it
 * must outlive the routed shell and must not sit inside a subtree the sidebar's collapse can
 * unmount. Both slots paint NOTHING when nobody registers them or the registrant is
 * disabled, which is what makes turning a diagnostic plugin off remove its chrome entirely
 * rather than leave an inert box floating over the workspace.
 */
export function App({ identity }: AppProps) {
  const [route, setRoute] = useState<Route>(() => currentRoute());

  useEffect(() => {
    const onPopState = (): void => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /*
    THE REQUESTED ADDRESS IS CONSUMED ONCE. It stays in React state — the gate publishes it and
    a surface answers it — while the address bar goes back to naming the PLACE. Two reasons, and
    both are about the link working the second time: a reader who closes what opened must not
    have it reopen on the next render, and following the same link again has to be a fresh
    request rather than a no-op against an unchanged URL.

    `replaceState` rather than `navigate`: this is not a navigation, it is the same route with
    its request answered, and pushing a history entry would make Back reopen it.
  */
  useEffect(() => {
    if (route.kind !== "browser" || route.requestedRef === null) return;
    if (window.location.search === "") return;
    window.history.replaceState(null, "", window.location.pathname);
  }, [route]);

  const navigate = useCallback((path: string, options?: { readonly replace?: boolean }): void => {
    if (`${window.location.pathname}${window.location.search}` === path) return;
    window.history[options?.replace === true ? "replaceState" : "pushState"](null, "", path);
    setRoute(currentRoute());
  }, []);

  return (
    <NoticeProvider>
      <HostServicesGate
        identity={identity}
        navigate={navigate}
        containerId={route.kind === "browser" ? route.containerId : null}
        requestedRef={route.kind === "browser" ? route.requestedRef : null}
      >
        {renderRoute(route, identity, navigate)}
        <WorkspaceOverlays />
      </HostServicesGate>
    </NoticeProvider>
  );
}

/**
 * Every declared workspace overlay slot, in one place. It is its own component because it
 * needs the host ref the gate publishes, and a component below the gate is how floor chrome
 * reads a context the gate provides — the same shape `PluginRoute` uses one level down.
 *
 * The slot list is the CLOSED vocabulary, walked rather than spelled: adding a slot is a
 * one-line append in `@manifold/plugin` and this outlet mounts it without an edit, which is
 * what keeps the registrant and the mount site from drifting.
 */
function WorkspaceOverlays(): ReactElement {
  const host = useHostServices();
  return (
    <>
      {WORKSPACE_OVERLAY_SLOTS.map((slot) => (
        <WorkspaceOverlayOutlet key={slot} slot={slot} host={host} />
      ))}
    </>
  );
}

/**
 * A plugin-owned route. Every failure mode is the shared inert ref NAMING what is
 * missing: an unclaimed prefix, a disabled plugin, or a declared route whose web half is
 * absent — the same three answers `PanelOutlet` gives for a panel.
 */
function PluginRoute({ prefix, rest }: { readonly prefix: string; readonly rest: string }) {
  const assembly = useAssembly();
  const host = useHostServices();
  const route = assembly.routes.get(prefix);

  if (route === undefined) {
    return (
      <main className="gate-screen">
        <PluginPlaceholder name={`/${prefix}`} state="unknown" />
      </main>
    );
  }
  const name = assembly.pluginTitle(route.plugin) ?? route.plugin;
  if (!route.enabled || route.Component === null) {
    return (
      <main className="gate-screen">
        <PluginPlaceholder name={name} state={route.enabled ? "unavailable" : "disabled"} />
      </main>
    );
  }
  const Component = route.Component;
  return <Component rest={rest} host={host} />;
}

function renderRoute(
  route: Route,
  identity: StoredIdentity,
  navigate: (path: string, options?: { readonly replace?: boolean }) => void,
) {
  switch (route.kind) {
    case "browser":
      return (
        <WorkspaceHost
          identity={identity}
          requestedContainerId={route.containerId}
          navigate={navigate}
        />
      );
    case "plugin":
      return <PluginRoute prefix={route.prefix} rest={route.rest} />;
    case "not_found":
      return (
        <main className="gate-screen">
          <section className="gate-card">
            <p className="eyebrow">not found</p>
            <h1>This manifold route does not exist</h1>
            <button className="primary-button" type="button" onClick={() => navigate("/")}>
              Open manifold
            </button>
          </section>
        </main>
      );
    default: {
      const exhaustiveRoute: never = route;
      return exhaustiveRoute;
    }
  }
}
