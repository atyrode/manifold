import { useCallback, useEffect, useState } from "react";
import type { StoredIdentity } from "./api.ts";
import { PadBrowser } from "./pad-browser.tsx";
import {
  HostServicesGate,
  PluginPlaceholder,
  useComposition,
  useHostServices,
} from "./plugin-host.tsx";
import { ToastProvider } from "./toast.tsx";

type Route =
  | { readonly kind: "browser"; readonly padId: string | null }
  /**
   * A route a PLUGIN owns, addressed by its first path segment (`/uri/<rest>`). The engine
   * resolves the segment against the composition and hands the rest over verbatim: which
   * plugin answers `uri` is not knowledge this table holds.
   */
  | { readonly kind: "plugin"; readonly prefix: string; readonly rest: string }
  | { readonly kind: "not_found" };

const PLUGIN_ROUTE = /^\/([a-z][a-z0-9-]*)\/(.+)$/;

function currentRoute(): Route {
  if (window.location.pathname === "/") return { kind: "browser", padId: null };
  const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
  if (match?.[1] !== undefined) {
    try {
      return { kind: "browser", padId: decodeURIComponent(match[1]) };
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
 * The toast layer is mounted HERE, above every route: it must outlive the shell it
 * reports for (a renderer that crashes into the error boundary still has notices to
 * show) and it must sit outside the sidebar's collapse subtree, which is what used to
 * hide sidebar failures on the icon rail.
 *
 * `HostServicesGate` sits above the route switch for the same reason: a plugin route is
 * plugin code, so it needs the one host surface (`client`, `navigate`, `viewport`) exactly
 * like a panel or a section does.
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
    <ToastProvider>
      <HostServicesGate
        identity={identity}
        navigate={navigate}
        padId={route.kind === "browser" ? route.padId : null}
      >
        {renderRoute(route, identity, navigate)}
      </HostServicesGate>
    </ToastProvider>
  );
}

/**
 * A plugin-owned route. Every failure mode is the shared inert surface NAMING what is
 * missing: an unclaimed prefix, a disabled plugin, or a declared route whose web half is
 * absent — the same three answers `PanelOutlet` gives for a panel.
 */
function PluginRoute({ prefix, rest }: { readonly prefix: string; readonly rest: string }) {
  const composition = useComposition();
  const host = useHostServices();
  const route = composition.routes.get(prefix);

  if (route === undefined) {
    return (
      <main className="gate-screen">
        <PluginPlaceholder name={`/${prefix}`} state="unknown" />
      </main>
    );
  }
  const name = composition.pluginTitle(route.plugin) ?? route.plugin;
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
      return <PadBrowser identity={identity} requestedPadId={route.padId} navigate={navigate} />;
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
