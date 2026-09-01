import {
  WORKSPACE_OVERLAY_SLOTS,
  WorkspaceOverlayOutlet,
} from "@manifold/plugin/hooks";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { StoredIdentity } from "./api.ts";
import { WorkspaceHost } from "./workspace.tsx";
import {
  HostServicesGate,
  PluginPlaceholder,
  useAssembly,
  useHostServices,
} from "./plugin-host.tsx";
import { NoticeProvider } from "./notice.tsx";

type Route =
  | { readonly kind: "browser"; readonly containerId: string | null }
  /**
   * A route a PLUGIN owns, addressed by its first path segment (`/uri/<rest>`). The engine
   * resolves the segment against the composition and hands the rest over verbatim: which
   * plugin answers `uri` is not knowledge this table holds.
   */
  | { readonly kind: "plugin"; readonly prefix: string; readonly rest: string }
  | { readonly kind: "not_found" };

const PLUGIN_ROUTE = /^\/([a-z][a-z0-9-]*)\/(.+)$/;

function currentRoute(): Route {
  if (window.location.pathname === "/") return { kind: "browser", containerId: null };
  const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
  if (match?.[1] !== undefined) {
    try {
      return { kind: "browser", containerId: decodeURIComponent(match[1]) };
    } catch {
      return { kind: "not_found" };
    }
  }
  // Everything else with a leading segment is offered to the composition; an unclaimed
  // prefix falls through to a named placeholder rather than a silent 404.
  const plugin = PLUGIN_ROUTE.exec(window.location.pathname);
  if (plugin?.[1] !== undefined && plugin[2] !== undefined) {
    return { kind: "plugin", prefix: plugin[1], rest: plugin[2] };
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
