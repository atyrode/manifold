export type Bypass =
  | { readonly phase: "checking" | "unsupported" }
  | {
    readonly phase: "ready";
    readonly hasWorker: boolean;
    isCurrent(): boolean;
    dispose(): void;
  };

/** Capability negotiation contains no identity, target, envelope or typed credential data. */
export async function privateCredentialEntryBypass(onChanged: () => void): Promise<Bypass> {
  if (!("serviceWorker" in navigator)) {
    let disposed = false;
    return {
      phase: "ready",
      hasWorker: false,
      isCurrent: () => !disposed && !("serviceWorker" in navigator),
      dispose: () => { disposed = true; },
    };
  }
  const container = navigator.serviceWorker;
  const controller = container.controller;
  const lifetime = new AbortController();
  let registration: ServiceWorkerRegistration | undefined;
  let active: ServiceWorker | null = null;
  let installing: ServiceWorker | null = null;
  let waiting: ServiceWorker | null = null;
  let disposed = false;
  let ready = false;
  const states = new Map<ServiceWorker, ServiceWorkerState>();
  const isCurrent = (): boolean => {
    if (disposed || navigator.serviceWorker !== container || container.controller !== controller ||
      (controller !== null && controller.state !== "activated") ||
      (registration !== undefined && (
        registration.active !== active || active === null || active.state !== "activated" ||
        registration.installing !== installing || registration.waiting !== waiting
      ))) return false;
    for (const [worker, state] of states) {
      if (worker.state !== state) return false;
    }
    return true;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
  };
  const changed = (): void => {
    if (disposed) return;
    dispose();
    onChanged();
  };
  container.addEventListener("controllerchange", changed, { signal: lifetime.signal });
  try {
    // An uncontrolled launcher can still open a document controlled by this registration.
    registration = await container.getRegistration(CREDENTIAL_ENTRY_DOCUMENT_PATH);
    active = registration?.active ?? null;
    installing = registration?.installing ?? null;
    waiting = registration?.waiting ?? null;
    for (const worker of [controller, active, installing, waiting]) {
      if (worker === null || states.has(worker)) continue;
      states.set(worker, worker.state);
      worker.addEventListener("statechange", changed, { signal: lifetime.signal });
    }
    registration?.addEventListener("updatefound", changed, { signal: lifetime.signal });
    if (!isCurrent()) return { phase: "unsupported" };
    const [controllerSupported, activeSupported] = await Promise.all([
      controller === null || acknowledgePrivateBypass(controller, lifetime.signal),
      active === null || active === controller || acknowledgePrivateBypass(active, lifetime.signal),
    ]);
    if (!controllerSupported || !activeSupported || !isCurrent()) return { phase: "unsupported" };
    // Recheck scope selection as well as the live incarnation after asynchronous replies.
    if (await container.getRegistration(CREDENTIAL_ENTRY_DOCUMENT_PATH) !== registration ||
      !isCurrent()) return { phase: "unsupported" };
    ready = true;
    return { phase: "ready", hasWorker: controller !== null || active !== null, isCurrent, dispose };
  } catch {
    return { phase: "unsupported" };
  } finally {
    if (!ready) dispose();
  }
}

function acknowledgePrivateBypass(worker: ServiceWorker, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      channel.port2.close();
      resolve(value);
    };
    const aborted = (): void => finish(false);
    const timer = window.setTimeout(aborted, 2000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      finish(data !== null && typeof data === "object" &&
        Reflect.get(data, "type") === "manifold.private-credential-bypass" &&
        Reflect.get(data, "version") === 1 && Reflect.get(data, "supported") === true);
    };
    channel.port1.onmessageerror = aborted;
    try {
      // Query only the controller/active incarnation, never a waiting worker or activation.
      worker.postMessage({ type: "manifold.private-credential-bypass", version: 1 }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

export const CREDENTIAL_ENTRY_DOCUMENT_PATH = "/credential-entry.html";
export const CREDENTIAL_ENTRY_ASSETS_PREFIX = "/credential-entry-assets/";

/** Static aliases are reserved, never the names of ordinary authenticated plugin APIs. */
export function privateCredentialEntryStaticPath(pathname: string): boolean {
  if (pathname.startsWith("/api")) return false;
  const decoded = pathname.replace(/%(?:25)*([0-9a-f]{2})/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return /(?:^|[/\\])credential-entry/i.test(decoded);
}

/** One immutable private-document policy shared by the hub and development server. */
export const CREDENTIAL_ENTRY_SECURITY_HEADERS = Object.freeze([
  Object.freeze(["cache-control", "no-store"] as const),
  Object.freeze(["referrer-policy", "no-referrer"] as const),
  Object.freeze(["x-frame-options", "DENY"] as const),
  Object.freeze(["cross-origin-opener-policy", "noopener-allow-popups"] as const),
  Object.freeze(["cross-origin-resource-policy", "same-origin"] as const),
]);

export function privateCredentialEntryCsp(origin: string): string {
  // Foreign selected hubs remain device-local. This is graph isolation, not network confinement.
  return `default-src 'none'; script-src ${origin}${CREDENTIAL_ENTRY_ASSETS_PREFIX}; style-src ${origin}${CREDENTIAL_ENTRY_ASSETS_PREFIX}; connect-src https: http:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'`;
}
