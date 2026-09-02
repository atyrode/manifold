import type { HostServices } from "@manifold/plugin";
import { formatManifoldUri, parseManifoldUri } from "@manifold/protocol";
import { useEffect, useMemo, useState } from "react";

/**
 * `/uri/<encoded manifold:// address>` — the deep-link route `core.uri` contributes.
 *
 * A link is a NODE reference, so following one is two questions: which node, and where does
 * this browser have to be to show it. The first is `parseManifoldUri`; the second is
 * `host.navigate`, the shell's one door for "put the viewer at this address". An element or a
 * tile additionally asks the mounted container view to look at it, which is the same host call a
 * spotlight uses — one centering path, not a second one for links.
 *
 * A terminal is the one form this route resolves itself: a terminal's container is not in the
 * URI (a terminal lives wherever it was placed), so the index is consulted and the viewer is
 * taken to the container that holds it.
 */

/**
 * What an address ASKS FOR, decided from the address alone. Reading a link is a pure
 * question — decode, parse, classify — so it is answered during render; only the two
 * genuinely external steps (navigating the shell, asking the server where a terminal
 * lives) belong to an effect.
 */
type Target =
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "open"; readonly uri: string; readonly center: boolean }
  | { readonly state: "terminal"; readonly terminalId: string };

function resolveTarget(rest: string): Target {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return { state: "failed", reason: "This link is not a valid address." };
  }
  const ref = parseManifoldUri(decoded);
  if (ref === null) {
    return { state: "failed", reason: `${decoded} is not a manifold:// address.` };
  }
  switch (ref.kind) {
    case "container":
      return { state: "open", uri: decoded, center: false };
    case "element":
    case "tile":
      return { state: "open", uri: decoded, center: true };
    case "terminal":
      // Every terminal lives in a composition of its own — `containerId`, solo from birth — and
      // the URI names only the terminal, so the index is what answers "where is it".
      return { state: "terminal", terminalId: ref.terminalId };
    case "plugin":
      /*
        A PLUGIN IS A PLACE, and the shell's own navigation door knows which one: a plugin is
        shown by a surface INSIDE the workspace — whichever composed manager answers that
        form — rather than by a route of its own, so this hands the address straight back to
        `host.navigate` exactly as a container does and stops caring what happens next
        (`navigateUri`, issue #133). Nothing here names a manager, or knows that one exists.
       */
      return { state: "open", uri: decoded, center: false };
    case "principal":
    case "action":
      // Addressable, but not places: there is nowhere to send a browser for a capability
      // holder or a verb. Naming the form is more useful than a blank screen.
      return {
        state: "failed",
        reason: `${decoded} names a ${ref.kind}, which is not a place to open.`,
      };
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}

export interface UriRouteProps {
  /** Everything after `/uri/`, still percent-encoded. */
  readonly rest: string;
  readonly host: HostServices;
}

export function UriRoute({ rest, host }: UriRouteProps): React.ReactElement {
  const target = useMemo(() => resolveTarget(rest), [rest]);
  /*
    The one failure the address cannot predict: a syntactically perfect terminal link whose
    terminal is gone. It is stamped with the address it answered for, so a second link
    rendered by this same route starts clean without an effect reaching in to clear it.
  */
  const [lookupFailure, setLookupFailure] = useState<{
    readonly rest: string;
    readonly reason: string;
  } | null>(null);

  useEffect(() => {
    if (target.state === "failed") return;
    if (target.state === "open") {
      host.navigate(target.uri);
      // Lands immediately when the addressed container is already on screen; after a route change
      // the shell's own navigation owns the centering, because this route is gone by then.
      if (target.center) host.viewport?.centerOn(target.uri);
      return;
    }
    let cancelled = false;
    void host.client
      .allTerminals()
      .then((terminals) => {
        if (cancelled) return;
        const terminal = terminals.find((candidate) => candidate.id === target.terminalId);
        if (terminal === undefined) {
          setLookupFailure({ rest, reason: "That terminal no longer exists." });
          return;
        }
        host.navigate(formatManifoldUri({ kind: "container", containerId: terminal.homeId }));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLookupFailure({
          rest,
          reason: reason instanceof Error ? reason.message : "Could not look up that terminal.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [host, rest, target]);

  const failure =
    target.state === "failed"
      ? target.reason
      : lookupFailure?.rest === rest
        ? lookupFailure.reason
        : null;

  return (
    <main className="gate-screen" data-uri-route={rest}>
      <section className="gate-card">
        <p className="eyebrow">manifold link</p>
        {failure === null ? (
          <h1>Opening this address…</h1>
        ) : (
          <>
            <h1>This link goes nowhere</h1>
            <p>{failure}</p>
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
