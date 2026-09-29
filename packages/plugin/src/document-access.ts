import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ElementDocument } from "./host.ts";

export interface DocumentAccessOptions {
  readonly document?: ElementDocument;
  readonly mode?: "spectator" | "occupant";
}

export type DocumentAccessState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "unavailable"; readonly reason: string }
  | {
      readonly state: "ready";
      readonly doc: ElementDocument;
      readonly canWrite: boolean;
      readonly revision: number;
    };

/** A host-owned subscription, not a transport or a credential-bearing client. */
export interface DocumentAccessLease {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => DocumentAccessState;
}

/** Creating a lease is pure; subscribing acquires it and unsubscribing releases it. */
export interface DocumentAccessPort {
  lease(homeContainerId: string | null, options: DocumentAccessOptions): DocumentAccessLease;
}

const DocumentAccessContext = createContext<DocumentAccessPort | null>(null);

export function DocumentAccessProvider({
  value,
  children,
}: {
  readonly value: DocumentAccessPort;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(DocumentAccessContext.Provider, { value }, children);
}

const IDLE: DocumentAccessState = { state: "idle" };
const NO_HOST: DocumentAccessState = { state: "unavailable", reason: "host_unavailable" };
const idleLease: DocumentAccessLease = { subscribe: () => () => {}, getSnapshot: () => IDLE };
const unavailableLease: DocumentAccessLease = {
  subscribe: () => () => {},
  getSnapshot: () => NO_HOST,
};

/**
 * Read a document at its immutable authority home. Resting previews are spectators;
 * an editor requests occupant mode and still checks `canWrite` before enabling edits.
 */
export function useDocumentAccess(
  homeContainerId: string | null,
  options: DocumentAccessOptions = {},
): DocumentAccessState {
  const port = useContext(DocumentAccessContext);
  const document = options.document;
  const mode = options.mode ?? "spectator";
  const lease = useMemo(() => {
    if (homeContainerId === null) return idleLease;
    if (port === null) return unavailableLease;
    return port.lease(homeContainerId, { ...(document === undefined ? {} : { document }), mode });
  }, [port, homeContainerId, document, mode]);
  return useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
}
