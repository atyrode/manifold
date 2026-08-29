import { useCallback, useEffect, useState } from "react";
import type { StoredIdentity } from "./api.ts";
import { PadBrowser } from "./pad-browser.tsx";
import { ToastProvider } from "./toast.tsx";

type Route =
  { readonly kind: "browser"; readonly padId: string | null } | { readonly kind: "not_found" };

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

  return <ToastProvider>{renderRoute(route, identity, navigate)}</ToastProvider>;
}

function renderRoute(
  route: Route,
  identity: StoredIdentity,
  navigate: (path: string, options?: { readonly replace?: boolean }) => void,
) {
  switch (route.kind) {
    case "browser":
      return <PadBrowser identity={identity} requestedPadId={route.padId} navigate={navigate} />;
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
