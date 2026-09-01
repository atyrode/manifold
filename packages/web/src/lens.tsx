import { HealthResponseSchema, PROTOCOL_VERSION } from "@manifold/protocol";
import { instanceOrigin, instanceUrl, isForeignInstance } from "@manifold/plugin/hooks";
import { Cover } from "@manifold/plugin/ui";
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";

/**
 * WHAT THE LENS ITSELF IS DOING — the three facts about this window that no plugin can answer,
 * because they are about the app rather than about anything inside it: which instance it is
 * looking at, whether it can reach it, and whether the bundle it is running still speaks that
 * instance's protocol.
 *
 * IT NEVER BLOCKS ON A CHECK. The probe runs beside the first paint, not in front of it: a lens
 * loading from cache with no network paints its chrome and then SAYS it is offline, which is the
 * offline shell in one sentence. There is no spinner here to be indefinite, and no blank page to
 * mistake for a slow one.
 *
 * IT REFUSES EXACTLY ONE THING. A protocol mismatch (`AGENTS.md` invariant 10) is the one
 * condition where carrying on would be the lie: a stale cached bundle in front of a newer server
 * would dial `/ws/session`, be closed 4409 by version negotiation, and reconnect forever while
 * every panel looked ordinary. `v0.5.0` is the worked example of that failure mode being invisible
 * while systemd reported health. So the skew is named, in both directions, with the path out —
 * and it is a refusal a human reads, never a silent degrade.
 *
 * THE OFFLINE CONDITION IS A STATE, NOT A FORK. Nothing below hands a plugin a second code path,
 * and no contribution is withdrawn while the network is away: absence is ordinary
 * (`REGISTRY.md` §Disable semantics) and a disconnected workspace is a workspace whose reads
 * failed, which the roster, the layout and the connection row each already report on their own
 * account. This file adds the one sentence none of them can say — that the instance is not
 * answering at all.
 */

/** What the last probe of the instance found. `checking` paints nothing: it is not a condition. */
type LensCondition =
  | { readonly kind: "checking" }
  | { readonly kind: "ready" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "skew"; readonly protocol: number; readonly version: string };

/**
 * Asks the instance who it is. `/healthz` is the right door for this and the only one that is:
 * it is unauthenticated (so the answer is available before, and independently of, any grant), it
 * names the protocol version, and it is not a read of anything a viewer owns — so a lens can ask
 * "are we still speaking the same language" without asking for data it has no business caching.
 */
async function probeInstance(): Promise<LensCondition> {
  try {
    const response = await fetch(instanceUrl("/healthz"), { cache: "no-store" });
    if (!response.ok) throw new Error(`healthz answered ${String(response.status)}`);
    const health = HealthResponseSchema.parse(await response.json());
    if (health.protocolVersion === PROTOCOL_VERSION) return { kind: "ready" };
    return { kind: "skew", protocol: health.protocolVersion, version: health.version };
  } catch {
    /*
      Unreachable covers every way the answer can fail to arrive — no network, DNS gone, the
      instance down, a proxy in the way — deliberately as ONE condition, because they are one
      condition to the reader: this window is not talking to its instance. The distinctions are
      the browser's own network panel to make.
    */
    return { kind: "unreachable" };
  }
}

/**
 * Registers the app shell's cache (`packages/web/sw.js`) and reports when a NEWER generation is
 * installed and waiting. It never activates that generation on its own: swapping a running React
 * tree onto another build's chunks is the failure the wait exists to prevent, so the human gets
 * an offer and the reload does the rest.
 *
 * Only in a built app, because a dev server ships no shell to cache — the worker is emitted by
 * the build that produces the hashed assets it precaches. That is a fact about whether a shell
 * EXISTS, not a capability branch: nothing above this line asks whether a worker is installed.
 */
async function registerShellWorker(signal: AbortSignal, onWaiting: () => void): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (signal.aborted) return;
    /*
      A controller is what makes an update an UPDATE. On a first visit the worker installs with
      no predecessor, and offering to reload into the bundle already running would be noise.
    */
    const replacing = (): boolean => navigator.serviceWorker.controller !== null;
    if (registration.waiting !== null && replacing()) onWaiting();
    registration.addEventListener(
      "updatefound",
      () => {
        const arriving = registration.installing;
        if (arriving === null || !replacing()) return;
        arriving.addEventListener(
          "statechange",
          () => {
            if (arriving.state === "installed") onWaiting();
          },
          { signal },
        );
      },
      { signal },
    );
  } catch (reason: unknown) {
    // A refused registration costs the offline shell and nothing else, so it is reported rather
    // than surfaced: every door still works, and no affordance in the product claimed otherwise.
    console.error("evt=shell_worker_registration_failed", reason);
  }
}

/**
 * GET ME THE CURRENT LENS — the one way out of both "a newer build is waiting" and "this bundle
 * cannot speak to its instance", because they are the same request.
 *
 * A bare reload is not enough when a generation is waiting: the reloading tab is still a client
 * of the old registration, so the wait would outlive it and the banner would come back saying the
 * same thing. So the waiting worker is told to stop waiting and the reload happens when control
 * actually changes, which is the point at which every asset the document names comes from one
 * build. With no worker waiting there is nothing to hand over and a plain reload is exactly right:
 * navigations are network-first, so it fetches whatever the instance ships now.
 */
function updateShell(): void {
  if (!("serviceWorker" in navigator)) {
    window.location.reload();
    return;
  }
  void navigator.serviceWorker.getRegistration().then((registration) => {
    const waiting = registration?.waiting ?? null;
    if (waiting === null) {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
      once: true,
    });
    waiting.postMessage(null);
  });
}

/** One line of the banner: the word, the sentence under it, and at most one way out. */
interface LensRow {
  readonly id: string;
  readonly word: string;
  readonly detail: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
  readonly alarmed: boolean;
}

function LensBanner({ rows }: { readonly rows: readonly LensRow[] }): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="lens-layer">
      {rows.map((row) => (
        <div
          key={row.id}
          className={row.alarmed ? "lens-note lens-note--alarmed" : "lens-note"}
          role="status"
          data-testid={`lens-${row.id}`}
        >
          <span className="lens-note-body">
            <strong>{row.word}</strong> <span className="lens-note-detail">{row.detail}</span>
          </span>
          {row.action === null ? null : (
            <button className="lens-note-action" type="button" onClick={row.action.run}>
              {row.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The one refusal: this bundle and this instance do not speak the same protocol. Both directions
 * are stated because the fix is in a different place for each, and telling a human to reload when
 * reloading cannot help is worse than telling them nothing.
 */
function ProtocolRefusal({
  condition,
  recheck,
}: {
  readonly condition: Extract<LensCondition, { kind: "skew" }>;
  readonly recheck: () => void;
}): ReactElement {
  const appIsOlder = PROTOCOL_VERSION < condition.protocol;
  return (
    <main className="gate-screen">
      <Cover className="gate-cover">
        <section className="gate-card" aria-labelledby="lens-skew-title" data-testid="lens-skew">
          <p className="eyebrow">manifold</p>
          <h1 id="lens-skew-title">
            {appIsOlder ? "This app is out of date" : "This instance is out of date"}
          </h1>
          <p>
            {instanceOrigin()} runs manifold {condition.version} and speaks protocol{" "}
            {String(condition.protocol)}; this window speaks {String(PROTOCOL_VERSION)}.{" "}
            {appIsOlder
              ? "Reloading fetches the app this instance ships. Nothing was changed, and no work is lost."
              : "The instance has to be updated to this protocol; reloading this window cannot help. Nothing was changed, and no work is lost."}
          </p>
          <button
            className="primary-button"
            data-testid="lens-skew-action"
            type="button"
            onClick={appIsOlder ? updateShell : recheck}
          >
            {appIsOlder ? "Reload manifold" : "Check again"}
          </button>
        </section>
      </Cover>
    </main>
  );
}

/**
 * Wraps the whole application. Above the identity gate deliberately: which instance this device
 * looks at, and whether this bundle can speak to it, are settled before there is any question of
 * who is asking — a token is minted by one instance and means nothing at another.
 */
export function LensGate({ children }: { readonly children: ReactNode }): ReactElement {
  const [condition, setCondition] = useState<LensCondition>({ kind: "checking" });
  const [updateReady, setUpdateReady] = useState(false);

  const probe = useCallback((): void => {
    void probeInstance().then(setCondition);
  }, []);

  useEffect(() => {
    probe();
    const controller = new AbortController();
    /*
      Event-driven rather than polled: the browser already knows when connectivity returns, and a
      timer asking an instance whether it exists would be a second polling regime beside the
      feeds (`REGISTRY.md` §Budgets) for a question nobody is watching.
    */
    window.addEventListener("online", probe, { signal: controller.signal });
    window.addEventListener("offline", () => setCondition({ kind: "unreachable" }), {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [probe]);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const controller = new AbortController();
    void registerShellWorker(controller.signal, () => setUpdateReady(true));
    return () => controller.abort();
  }, []);

  if (condition.kind === "skew") return <ProtocolRefusal condition={condition} recheck={probe} />;

  const rows: LensRow[] = [];
  if (condition.kind === "unreachable") {
    rows.push({
      id: "offline",
      word: "Offline",
      detail: `Not connected to ${instanceOrigin()}. This is the cached app shell; nothing you change here will be saved.`,
      action: { label: "Retry", run: probe },
      alarmed: true,
    });
  }
  if (updateReady) {
    rows.push({
      id: "update",
      word: "Update ready",
      detail: "A newer manifold is on this device and takes effect on reload.",
      action: { label: "Reload", run: updateShell },
      alarmed: false,
    });
  }
  if (isForeignInstance()) {
    rows.push({
      id: "instance",
      word: "Another instance",
      detail: `This device is pointed at ${instanceOrigin()} rather than the instance that served it.`,
      // `?instance=` with no value is the carrier's own way home; `instance.ts` consumes it,
      // forgets the choice and leaves the URL clean.
      action: { label: "Look here again", run: () => window.location.assign("/?instance=") },
      alarmed: false,
    });
  }

  return (
    <>
      <LensBanner rows={rows} />
      {children}
    </>
  );
}
