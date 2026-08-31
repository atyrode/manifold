import type { HostServices } from "@manifold/plugin";
import { formatManifoldUri, parseManifoldUri } from "@manifold/protocol";
import { useEffect, useState } from "react";

/**
 * `/uri/<encoded manifold:// address>` — the deep-link route `core.uri` contributes.
 *
 * A link is a NODE reference, so following one is two questions: which node, and where does
 * this browser have to be to show it. The first is `parseManifoldUri`; the second is
 * `host.navigate`, the shell's one door for "put the viewer at this address". An element or a
 * tile additionally asks the mounted pad view to look at it, which is the same host call a
 * spotlight uses — one centering path, not a second one for links.
 *
 * A terminal is the one form this route resolves itself: a session's container is not in the
 * URI (a terminal lives wherever it was placed), so the index is consulted and the viewer is
 * taken to the container that holds it.
 */

type Outcome =
  | { readonly state: "working" }
  | { readonly state: "failed"; readonly reason: string };

export interface UriRouteProps {
  /** Everything after `/uri/`, still percent-encoded. */
  readonly rest: string;
  readonly host: HostServices;
}

export function UriRoute({ rest, host }: UriRouteProps): React.ReactElement {
  const [outcome, setOutcome] = useState<Outcome>({ state: "working" });

  useEffect(() => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      setOutcome({ state: "failed", reason: "This link is not a valid address." });
      return;
    }
    const ref = parseManifoldUri(decoded);
    if (ref === null) {
      setOutcome({ state: "failed", reason: `${decoded} is not a manifold:// address.` });
      return;
    }
    let cancelled = false;
    switch (ref.kind) {
      case "pad":
        host.navigate(decoded);
        return;
      case "element":
      case "tile":
        host.navigate(decoded);
        // Lands immediately when the addressed pad is already on screen; after a route change
        // the shell's own navigation owns the centering, because this route is gone by then.
        host.viewport?.centerOn(decoded);
        return;
      case "terminal": {
        // Every terminal lives in a composition of its own — `homeId`, solo from birth — and
        // the URI names only the session, so the index is what answers "where is it".
        void host.client
          .terminals()
          .then((terminals) => {
            if (cancelled) return;
            const session = terminals.find((candidate) => candidate.id === ref.sessionId);
            if (session === undefined) {
              setOutcome({ state: "failed", reason: "That terminal no longer exists." });
              return;
            }
            host.navigate(formatManifoldUri({ kind: "pad", padId: session.homeId }));
          })
          .catch((reason: unknown) => {
            if (cancelled) return;
            setOutcome({
              state: "failed",
              reason: reason instanceof Error ? reason.message : "Could not look up that terminal.",
            });
          });
        return () => {
          cancelled = true;
        };
      }
      case "principal":
      case "plugin":
      case "action":
        // Addressable, but not places: there is nowhere to send a browser for a capability
        // holder, a plugin or a verb. Naming the form is more useful than a blank screen.
        setOutcome({
          state: "failed",
          reason: `${decoded} names a ${ref.kind}, which is not a place to open.`,
        });
        return;
      default: {
        const exhaustive: never = ref;
        return exhaustive;
      }
    }
  }, [host, rest]);

  return (
    <main className="gate-screen" data-uri-route={rest}>
      <section className="gate-card">
        <p className="eyebrow">manifold link</p>
        {outcome.state === "working" ? (
          <h1>Opening this address…</h1>
        ) : (
          <>
            <h1>This link goes nowhere</h1>
            <p>{outcome.reason}</p>
            <button
              className="primary-button"
              type="button"
              // The workspace root is a browser route, not a node: it is the one path the
              // host's navigate door takes verbatim.
              onClick={() => host.navigate("/")}
            >
              Open manifold
            </button>
          </>
        )}
      </section>
    </main>
  );
}

/**
 * What this plugin registers in the browser. Routes are keyed by their FIRST path segment, so
 * this one owns `/uri/**` and nothing else.
 */
export const uriWebPlugin = {
  id: "core.uri",
  routes: { uri: UriRoute },
};
