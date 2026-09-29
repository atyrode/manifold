import type { ElementDocument } from "@manifold/plugin";
import {
  DocumentAccessProvider,
  sessionUrl,
  type DocumentAccessLease,
  type DocumentAccessOptions,
  type DocumentAccessPort,
  type DocumentAccessState,
} from "@manifold/plugin/hooks";
import { CHANNEL_LIMIT_CLOSE_CODE, MAX_SESSION_CHANNELS_PER_CONNECTION } from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";
import { useLayoutEffect, useMemo, type ReactElement, type ReactNode } from "react";
import type { StoredIdentity } from "./api.ts";

const IDLE: DocumentAccessState = { state: "idle" };
const LOADING: DocumentAccessState = { state: "loading" };
const LIMIT: DocumentAccessState = { state: "unavailable", reason: "limit" };
type Mode = "spectator" | "occupant";
const documentPorts = new WeakMap<ElementDocument, ElementDocument>();

function unavailable(document: ElementDocument): DocumentAccessState {
  const code = document.connectionError?.code;
  const reason =
    code === 4404
      ? "missing"
      : code === 4403
        ? "forbidden"
        : code === CHANNEL_LIMIT_CLOSE_CODE
          ? "limit"
          : code === 4401
            ? "unauthorized"
            : code === 4409
              ? "protocol_mismatch"
              : "disconnected";
  return { state: "unavailable", reason };
}

/** Only the document port crosses into plugin code, never the SDK transport/action surface. */
function documentPort(document: ElementDocument): ElementDocument {
  const existing = documentPorts.get(document);
  if (existing !== undefined) return existing;
  const port: ElementDocument = {
    get containerId() {
      return document.containerId;
    },
    get spectator() {
      return document.spectator;
    },
    get epoch() {
      return document.epoch;
    },
    get status() {
      return document.status;
    },
    get connectionError() {
      const error = document.connectionError;
      return error === null ? null : { code: error.code, reason: error.reason };
    },
    selfCaps: () => document.selfCaps(),
    sharedText: (namespace, id) => document.sharedText(namespace, id),
    sharedTexts: (namespace) => document.sharedTexts(namespace),
    elementText: (id) => document.elementText(id),
    transact: (fn) => {
      if (
        document.spectator ||
        document.status !== "open" ||
        !document.selfCaps().includes("scenes:write")
      ) {
        throw new Error("document is read-only");
      }
      document.transact(fn);
    },
    on: document.on.bind(document),
  };
  documentPorts.set(document, port);
  return port;
}

function documentState(document: ElementDocument, revision: number): DocumentAccessState {
  if (document.status === "closed") return unavailable(document);
  if (document.epoch === "") return LOADING;
  return {
    state: "ready",
    doc: documentPort(document),
    canWrite:
      !document.spectator &&
      document.status === "open" &&
      document.selfCaps().includes("scenes:write"),
    revision,
  };
}

/** One observed document lifetime. A promoted entry keeps its consumers, not its old client. */
class DocumentEntry {
  readonly listeners = new Set<() => void>();
  state: DocumentAccessState = LOADING;
  mode: Mode;
  private revision = 0;
  private off: (() => void)[] = [];
  private client: SessionClient | null = null;
  private generation = 0;

  constructor(mode: Mode) {
    this.mode = mode;
  }

  private publish(state: DocumentAccessState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  observe(document: ElementDocument): void {
    const changed = (): void => {
      this.revision += 1;
      this.publish(documentState(document, this.revision));
      if (document.status === "closed" && this.client !== null) this.stopClient();
    };
    this.off = [
      document.on("status", changed),
      document.on("scene_reset", changed),
      document.on("shared_texts_changed", changed),
    ];
    changed();
  }

  open(url: string, token: string, home: string, mode: Mode): void {
    // Leave the spectator before acquiring the occupant. The pool still owns the socket.
    this.stopClient();
    this.mode = mode;
    this.publish(LOADING);
    const generation = this.generation;
    const client = new SessionClient({
      url,
      token,
      containerId: home,
      spectator: mode === "spectator",
    });
    this.client = client;
    this.observe(client);
    void client.connect().catch(() => {
      // A released/promoted client's rejection belongs to its retired generation.
      if (generation !== this.generation) return;
      this.publish(unavailable(client));
      this.stopClient();
    });
  }

  private stopClient(): void {
    this.generation += 1;
    for (const off of this.off) off();
    this.off = [];
    const client = this.client;
    this.client = null;
    client?.close();
  }

  retire(): void {
    this.stopClient();
    this.publish({ state: "unavailable", reason: "released" });
  }
}

interface HeldDocument {
  readonly entry: DocumentEntry;
  readonly release: () => void;
}

/** Bounded authority-home leases. No entry is downgraded while a consumer still holds it. */
class NativeDocumentAccess implements DocumentAccessPort {
  private readonly homes = new Map<string, DocumentEntry>();
  private readonly borrowed = new Set<DocumentEntry>();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private acquire(
    home: string,
    options: DocumentAccessOptions,
    listener: () => void,
  ): HeldDocument | null {
    const mode = options.mode ?? "spectator";
    const supplied = options.document;
    if (supplied?.containerId === home && (mode === "spectator" || !supplied.spectator)) {
      const entry = new DocumentEntry(mode);
      this.borrowed.add(entry);
      entry.observe(supplied);
      entry.listeners.add(listener);
      return {
        entry,
        release: () => {
          entry.listeners.delete(listener);
          this.borrowed.delete(entry);
          // Only subscriptions belong to the host; never close a caller-owned document.
          entry.retire();
        },
      };
    }

    let entry = this.homes.get(home);
    if (entry === undefined) {
      if (this.homes.size >= MAX_SESSION_CHANNELS_PER_CONNECTION) return null;
      entry = new DocumentEntry(mode);
      this.homes.set(home, entry);
      entry.open(this.url, this.token, home, mode);
    } else if (mode === "occupant" && entry.mode === "spectator") {
      entry.open(this.url, this.token, home, mode);
    }
    entry.listeners.add(listener);
    const held = entry;
    return {
      entry,
      release: () => {
        held.listeners.delete(listener);
        // React replaces subscriptions in one commit (including mode changes and StrictMode).
        // Retain through that checkpoint, not through an idle timer or a second client.
        queueMicrotask(() => {
          if (held.listeners.size !== 0 || this.homes.get(home) !== held) return;
          this.homes.delete(home);
          held.retire();
        });
      },
    };
  }

  lease(home: string | null, options: DocumentAccessOptions): DocumentAccessLease {
    const supplied = options.document;
    const mode = options.mode ?? "spectator";
    const initial =
      home === null
        ? IDLE
        : supplied?.containerId === home && (mode === "spectator" || !supplied.spectator)
          ? documentState(supplied, 0)
          : (this.homes.get(home)?.state ?? LOADING);
    // A role-only change must not briefly become loading and unmount a healthy editor.
    let state: DocumentAccessState =
      initial.state === "ready" && mode === "spectator" && initial.canWrite
        ? { ...initial, canWrite: false }
        : initial;
    let held: HeldDocument | null = null;
    const listeners = new Set<() => void>();
    const changed = (): void => {
      const next = held?.entry.state ?? (home === null ? IDLE : LIMIT);
      state =
        next.state === "ready" && options.mode !== "occupant" && next.canWrite
          ? { ...next, canWrite: false }
          : next;
      for (const listener of listeners) listener();
    };
    return {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        if (listeners.size === 1 && home !== null) {
          held = this.acquire(home, options, changed);
          changed();
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size !== 0) return;
          held?.release();
          held = null;
          state = home === null ? IDLE : LOADING;
        };
      },
    };
  }

  retire(): void {
    const entries = [...this.homes.values(), ...this.borrowed];
    this.homes.clear();
    this.borrowed.clear();
    for (const entry of entries) entry.retire();
  }
}

/** Mounted above the route switch: standalone plugin routes have exactly the same door. */
export function NativeDocumentAccessProvider({
  identity,
  children,
}: {
  readonly identity: StoredIdentity;
  readonly children: ReactNode;
}): ReactElement {
  const url = sessionUrl();
  const access = useMemo(() => new NativeDocumentAccess(url, identity.token), [url, identity.token]);
  useLayoutEffect(() => () => access.retire(), [access]);
  return <DocumentAccessProvider value={access}>{children}</DocumentAccessProvider>;
}
