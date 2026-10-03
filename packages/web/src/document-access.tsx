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
import { useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import type { StoredIdentity } from "./identity-storage.ts";

const IDLE: DocumentAccessState = { state: "idle" };
const LOADING: DocumentAccessState = { state: "loading" };
const LIMIT: DocumentAccessState = { state: "unavailable", reason: "limit" };
const RELEASED: DocumentAccessState = { state: "unavailable", reason: "released" };
type Mode = "spectator" | "occupant";
const documentPorts = new WeakMap<SessionClient, ElementDocument>();
const documentSources = new WeakMap<ElementDocument, SessionClient>();

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
function documentPort(document: SessionClient): ElementDocument {
  const existing = documentPorts.get(document);
  if (existing !== undefined) return existing;
  const port: ElementDocument = {
    get containerId() {
      return document.containerId;
    },
    get spectator() {
      return document.spectator;
    },
    get sceneWriteAllowed() {
      return document.sceneWriteAllowed;
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
      if (document.spectator || document.status !== "open" || !document.sceneWriteAllowed) {
        throw new Error("document is read-only");
      }
      document.transact(fn);
    },
    on: document.on.bind(document),
  };
  documentPorts.set(document, port);
  documentSources.set(port, document);
  return port;
}

function documentState(document: SessionClient, revision: number): DocumentAccessState {
  if (document.status === "closed") return unavailable(document);
  if (document.epoch === "") return LOADING;
  return {
    state: "ready",
    doc: documentPort(document),
    canWrite: !document.spectator && document.status === "open" && document.sceneWriteAllowed,
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

  constructor(
    mode: Mode,
    private readonly onBorrowedRetired: (entry: DocumentEntry) => void,
  ) {
    this.mode = mode;
  }

  private publish(state: DocumentAccessState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private observe(document: SessionClient): void {
    const generation = this.generation;
    let observedActive = false;
    const changed = (): void => {
      this.revision += 1;
      if (document.status !== "closed") observedActive = true;
      if (
        this.client === null &&
        observedActive &&
        document.status === "closed" &&
        document.connectionError === null
      ) {
        this.publish(LOADING);
        queueMicrotask(() => {
          if (
            generation === this.generation &&
            document.status === "closed" &&
            document.connectionError === null
          ) {
            this.onBorrowedRetired(this);
          }
        });
      } else {
        this.publish(documentState(document, this.revision));
        if (document.status === "closed" && this.client !== null) this.stopClient();
      }
    };
    this.off = [
      document.on("status", changed),
      document.on("scene_reset", changed),
      document.on("scene_authority_changed", changed),
      document.on("shared_texts_changed", changed),
    ];
    changed();
  }

  borrow(document: SessionClient): void {
    this.stopClient();
    this.mode = document.spectator ? "spectator" : "occupant";
    this.observe(document);
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
    this.publish(RELEASED);
  }
}

interface HeldDocument {
  readonly entry: DocumentEntry;
  readonly release: () => void;
}

/** Bounded authority-home leases. No entry is downgraded while a consumer still holds it. */
export class NativeDocumentAccess implements DocumentAccessPort {
  private readonly homes = new Map<string, DocumentEntry>();
  private readonly mounted = new Set<DocumentEntry>();
  private retired = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private supplied(home: string, options: DocumentAccessOptions): SessionClient | undefined {
    const document = options.document;
    if (document === undefined) return undefined;
    const source = document instanceof SessionClient ? document : documentSources.get(document);
    return source?.containerId === home && source.matchesConnectionIdentity(this.url, this.token)
      ? source
      : undefined;
  }

  private acquire(
    home: string,
    options: DocumentAccessOptions,
    listener: () => void,
  ): HeldDocument | null {
    if (this.retired) return null;
    const mode = options.mode ?? "spectator";
    const supplied = this.supplied(home, options);
    if (options.binding === "mounted") {
      if (supplied === undefined) return null;
      // This lifetime belongs to the mount, including spectator/occupant swaps. Pooling
      // it would retain an occupant after disengagement or reopen a removed portal.
      const mounted = new DocumentEntry(mode, () => undefined);
      mounted.borrow(supplied);
      mounted.listeners.add(listener);
      this.mounted.add(mounted);
      return {
        entry: mounted,
        release: () => {
          this.mounted.delete(mounted);
          mounted.listeners.delete(listener);
          mounted.retire();
        },
      };
    }
    let entry = this.homes.get(home);
    if (entry === undefined) {
      if (this.homes.size >= MAX_SESSION_CHANNELS_PER_CONNECTION) return null;
      entry = new DocumentEntry(mode, (retiring) => {
        // A caller-owned canvas may retire in the same commit that its standalone reader
        // remains mounted. Transfer only a normally closed, still-held logical home.
        if (!this.retired && this.homes.get(home) === retiring && retiring.listeners.size > 0) {
          retiring.open(this.url, this.token, home, retiring.mode);
        }
      });
      this.homes.set(home, entry);
      if (supplied !== undefined && (mode === "spectator" || !supplied.spectator)) {
        entry.borrow(supplied);
      } else {
        entry.open(this.url, this.token, home, mode);
      }
    } else if (
      mode === "occupant" &&
      entry.mode === "spectator" &&
      entry.state.state !== "unavailable"
    ) {
      if (supplied !== undefined && !supplied.spectator) {
        entry.borrow(supplied);
      } else {
        entry.open(this.url, this.token, home, mode);
      }
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
    const supplied = home === null ? undefined : this.supplied(home, options);
    const mode = options.mode ?? "spectator";
    const initial =
      home === null
        ? IDLE
        : this.retired
          ? RELEASED
          : options.binding === "mounted"
            ? supplied === undefined
              ? LOADING
              : documentState(supplied, 0)
            : (this.homes.get(home)?.state ??
              (supplied !== undefined && (mode === "spectator" || !supplied.spectator)
                ? documentState(supplied, 0)
                : LOADING));
    // A role-only change must not briefly become loading and unmount a healthy editor.
    let state: DocumentAccessState =
      initial.state === "ready" && mode === "spectator" && initial.canWrite
        ? { ...initial, canWrite: false }
        : initial;
    let held: HeldDocument | null = null;
    const listeners = new Set<() => void>();
    const changed = (): void => {
      const next = this.retired ? RELEASED : (held?.entry.state ?? (home === null ? IDLE : LIMIT));
      state =
        next.state === "ready" && options.mode !== "occupant" && next.canWrite
          ? { ...next, canWrite: false }
          : next;
      for (const listener of listeners) listener();
    };
    return {
      getSnapshot: () => (home !== null && this.retired ? RELEASED : state),
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
    if (this.retired) return;
    this.retired = true;
    const entries = [...this.homes.values(), ...this.mounted];
    this.homes.clear();
    this.mounted.clear();
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
  const access = useMemo(
    () => new NativeDocumentAccess(url, identity.token),
    [url, identity.token],
  );
  const lifetime = useRef<{ access: NativeDocumentAccess; generation: object } | null>(null);
  useLayoutEffect(() => {
    const generation = {};
    lifetime.current = { access, generation };
    return () => {
      // StrictMode replays effect setup on the same controller in this commit. A real
      // unmount or authority replacement retires it terminally at the checkpoint.
      queueMicrotask(() => {
        if (lifetime.current?.access !== access || lifetime.current.generation === generation) {
          access.retire();
        }
      });
    };
  }, [access]);
  return <DocumentAccessProvider value={access}>{children}</DocumentAccessProvider>;
}
