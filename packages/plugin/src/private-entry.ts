export type Bypass = { phase: "checking" | "ready" | "unsupported"; controller: ServiceWorker | null };

/** Capability negotiation contains no identity, target, envelope or typed credential data. */
export async function privateCredentialEntryBypass(): Promise<Bypass> {
    if (!("serviceWorker" in navigator)) return { phase: "ready", controller: null };
    const controller = navigator.serviceWorker.controller;
    if (controller === null) return { phase: "ready", controller: null };
    const supported = await new Promise<boolean>((resolve) => {
        const channel = new MessageChannel();
        const finish = (value: boolean): void => {
            window.clearTimeout(timer);
            channel.port1.close();
            channel.port2.close();
            resolve(value);
        };
        const timer = window.setTimeout(() => finish(false), 2000);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
            const data = event.data;
            finish(data !== null && typeof data === "object" &&
                Reflect.get(data, "type") === "manifold.private-credential-bypass" &&
                Reflect.get(data, "version") === 1 && Reflect.get(data, "supported") === true);
        };
        try {
            // The old worker ignores the reply port; querying its active incarnation cannot activate
            // a waiting worker. In particular this is not the ordinary null activation message.
            controller.postMessage({ type: "manifold.private-credential-bypass", version: 1 }, [channel.port2]);
        } catch {
            finish(false);
        }
    });
    return {
        phase: supported && navigator.serviceWorker.controller === controller ? "ready" : "unsupported",
        controller,
    };
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
