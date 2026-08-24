import { useCallback, useEffect, useState } from "react";
import type { StoredIdentity } from "./api.ts";
import { PadErrorBoundary } from "./error-boundary.tsx";
import { PadList } from "./pad-list.tsx";
import { PadView } from "./pad-view.tsx";

type Route =
  | { readonly kind: "pads" }
  | { readonly kind: "pad"; readonly padId: string }
  | { readonly kind: "not_found" };

function currentRoute(): Route {
  if (window.location.pathname === "/") return { kind: "pads" };
  const match = /^\/p\/([^/]+)$/.exec(window.location.pathname);
  if (match?.[1] !== undefined) {
    try {
      return { kind: "pad", padId: decodeURIComponent(match[1]) };
    } catch {
      return { kind: "not_found" };
    }
  }
  return { kind: "not_found" };
}

interface AppProps {
  readonly identity: StoredIdentity;
}

/** Routes the two v0 browser surfaces using the platform history API only. */
export function App({ identity }: AppProps) {
  const [route, setRoute] = useState<Route>(() => currentRoute());

  useEffect(() => {
    const onPopState = (): void => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string): void => {
    if (`${window.location.pathname}${window.location.search}` === path) return;
    window.history.pushState(null, "", path);
    setRoute(currentRoute());
  }, []);

  switch (route.kind) {
    case "pads":
      return <PadList identity={identity} navigate={navigate} />;
    case "pad":
      return (
        <PadErrorBoundary key={route.padId}>
          <PadView padId={route.padId} identity={identity} navigate={navigate} />
        </PadErrorBoundary>
      );
    case "not_found":
      return (
        <main className="gate-screen">
          <section className="gate-card">
            <p className="eyebrow">not found</p>
            <h1>This manifold route does not exist</h1>
            <button className="primary-button" type="button" onClick={() => navigate("/")}>
              Back to pads
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
