import {
  ByteCarrierRequestSchema,
  ByteReadChunkSchema,
  ByteRefusalSchema,
  ByteTransferError,
  ByteWriteReceiptSchema,
  MAX_BYTE_REQUESTS,
  MAX_BYTE_CHUNK_BYTES,
  LocalFileHandleSchema,
  type ByteCarrierRequest,
  HARDENED_CONTRACT_VERSION,
  WebIsolateHostFrameSchema,
  WebIsolateWorkerFrameSchema,
  type ActionOutcome,
  type ContainerTerminalSummary,
  type MachineSummary,
  type ManifoldRef,
  type PanelArg,
  type PortablePanelInput,
  type ResolveResponse,
  type PortableElementProjection,
  type StreamServerMessage,
  type TerminalInfo,
  type WebHostContext,
  type WebHostMethod,
  type WebIsolateHostFrame,
  type WebIsolateWorkerFrame,
} from "@manifold/protocol";
import type {
  AuthoringHandle,
  LocalFilesHandle,
  PortableElementProps,
  PlaceOutcome,
  PortableHostServices,
  PortablePanelProps,
  PortableSessionHandle,
  SessionStatus,
  StreamHandle,
} from "@manifold/plugin";
import { FrameModeProvider } from "@manifold/ui/frames";
import { createElement, type ComponentType } from "react";
import { HostCallError } from "./errors.ts";
import { createUiRoot, type UiRoot } from "./frame-root.ts";
import type { ReactWebPluginDef } from "./web.ts";

/**
 * THE WEB GUEST RUNTIME (ADR 0016 §1, §3; ADR 0053). A hardened web half runs in a dedicated
 * Worker the page creates from the bundle's portable entry; this module is the Worker's end of
 * that `postMessage` channel. Each mounted panel or section is one retained React root whose
 * committed trees leave as `render` frames and whose control events come back by name. Host
 * services are `call` frames the page serves from the MOUNTED contribution's real host, every
 * one carrying its owning instance, so a Worker acts with the viewer's authority without ever
 * holding the viewer's token. Mounted host facts arrive as data (`context`) and refresh props
 * without resetting component state; event-plane invalidations arrive payload-free
 * (`notification`) and are acknowledged once handled.
 */

/** The Worker's end of `postMessage`, as three verbs; tests bind them to an in-memory pair. */
export interface WebGuestPort {
  post(frame: WebIsolateWorkerFrame, transfer?: ArrayBuffer[]): void;
  onMessage(listener: (data: unknown) => void): void;
  warn(line: string): void;
}

/** Outstanding host calls, open streams and event subscriptions one Worker may hold. */
const MAX_PENDING_CALLS = 256;
const MAX_STREAMS = 64;
const MAX_SUBSCRIPTIONS = 64;
/** Replies still owed to retired calls, absorbed silently; oldest forgotten first. */
const MAX_RETIRED_CALLS = 1024;

type Kind = "panel" | "section" | "element";
type Contribution = ComponentType<PortablePanelProps> | ComponentType<PortableElementProps>;
type StreamOptions = Parameters<PortableSessionHandle["openStream"]>[0];

/** One mounted instance's identity and host-side state: what its services close over. */
interface Owner {
  readonly id: string;
  readonly label: string;
  readonly kind: Kind;
  context: WebHostContext;
  /** False from the moment the page unmounts it or it faults: its calls refuse locally. */
  live: boolean;
  readonly streams: Set<string>;
  readonly subscriptions: Set<string>;
  readonly statusListeners: Set<(status: SessionStatus) => void>;
  readonly visibilityListeners: Set<() => void>;
}

interface Mounted extends Owner {
  readonly component: Contribution;
  readonly root: UiRoot;
  readonly client: PortableSessionHandle;
  readonly navigate: (uri: string) => void;
  readonly authoring: AuthoringHandle;
  readonly localFiles: LocalFilesHandle;
  host: PortableHostServices;
  /** The host facts `host` was built from; a new identity only when one of them changes. */
  hostKey: string;
  arg: PanelArg | undefined;
  argKey: string | undefined;
  readonly input: PortablePanelInput | undefined;
  readonly onResult: ((result: PanelArg) => void) | undefined;
  element: PortableElementProjection | undefined;
  elementKey: string | undefined;
}

interface PendingCall {
  readonly method: WebHostMethod;
  /** Null for the runtime's own release calls, which outlive their owner. */
  readonly owner: Owner | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface OpenStream {
  readonly owner: Owner;
  receive(message: StreamServerMessage): void;
  /** Ends the handle locally; the page already released (or is being told to release) it. */
  drop(): void;
}

interface Subscription {
  readonly owner: Owner;
  readonly handler: (event: unknown) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueText(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
    .join("; ");
}

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

/** Why a module's default export is not a web definition, or null when it is one. */
function definitionProblem(def: unknown): string | null {
  if (typeof def !== "object" || def === null) {
    return "the web entry's default export is not a web plugin definition";
  }
  const { id, panels, sections, elements } = def as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return "the web plugin definition has no id";
  for (const [name, registry] of [
    ["panels", panels],
    ["sections", sections],
    ["elements", elements],
  ] as const) {
    if (registry === undefined) continue;
    if (typeof registry !== "object" || registry === null) return `${name} must be a record`;
    for (const [local, component] of Object.entries(registry)) {
      if (!isComponent(component)) return `${name}.${local} is not a React component`;
    }
  }
  return null;
}

function hostKeyOf(context: WebHostContext): string {
  return JSON.stringify([
    context.principal,
    context.containerId,
    context.topics,
    context.canAuthor,
  ]);
}

function hostOf(
  context: WebHostContext,
  client: PortableSessionHandle,
  navigate: (uri: string) => void,
  authoring: AuthoringHandle,
  localFiles: LocalFilesHandle,
): PortableHostServices {
  return {
    principal: context.principal,
    containerId: context.containerId,
    topics: context.topics,
    navigate,
    authoring: context.canAuthor ? authoring : null,
    client,
    localFiles,
  };
}

/**
 * Wires a definition to a port and starts answering page frames. The packer's Worker entry
 * calls {@link startWebWorker}; tests call this with a fake page.
 */
export function attachWebGuest(def: ReactWebPluginDef, port: WebGuestPort): void {
  const pending = new Map<string, PendingCall>();
  const retired = new Set<string>();
  const instances = new Map<string, Mounted>();
  /** Instances this guest faulted; the page's later frames for them are expected, not strays. */
  const faulted = new Set<string>();
  const streams = new Map<string, OpenStream>();
  const subscriptions = new Map<string, Subscription>();
  let initialized = false;
  let callSeq = 0;
  let streamSeq = 0;
  let subscriptionSeq = 0;
  let byteSeq = 0;
  let byteRequests = 0;

  /** Every outgoing frame is parsed first: a kit bug fails here, never as a malformed frame. */
  const post = (frame: WebIsolateWorkerFrame, transfer?: ArrayBuffer[]): void => {
    const parsed = WebIsolateWorkerFrameSchema.parse(frame);
    if (transfer === undefined) port.post(parsed);
    else port.post(parsed, transfer);
  };

  const fault = (instance: string | undefined, error: string): void => {
    post(instance === undefined ? { t: "fault", error } : { t: "fault", instance, error });
  };

  const problem = definitionProblem(def);
  if (problem !== null) {
    fault(undefined, problem);
    return;
  }

  /**
   * One host call on behalf of a mounted owner. A call from an owner that is no longer live
   * refuses here: the page released it, and a stale completion must not act for it.
   */
  const send = (
    instance: string,
    owner: Owner | null,
    method: WebHostMethod,
    args: readonly unknown[],
    transfer?: ArrayBuffer[],
  ): Promise<unknown> => {
    if (owner !== null && !owner.live) {
      return Promise.reject(new Error(`${owner.label} is unmounted`));
    }
    if (pending.size >= MAX_PENDING_CALLS) {
      return Promise.reject(new Error("too many pending host calls"));
    }
    callSeq += 1;
    const id = `c${String(callSeq)}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pending.set(id, { method, owner, resolve, reject });
    try {
      post({ t: "call", id, instance, method, args: [...args] }, transfer);
    } catch (error) {
      pending.delete(id);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  };

  const warnFailure = (what: string) => (error: unknown) => {
    port.warn(`${what}: ${errorText(error)}`);
  };

  const streamFor = (mounted: Owner, options: StreamOptions): StreamHandle => {
    if (!mounted.live) throw new Error(`${mounted.label} is unmounted`);
    if (streams.size >= MAX_STREAMS) throw new Error("too many stream subscriptions");
    streamSeq += 1;
    const id = `s${String(streamSeq)}`;
    let snapshot: StreamHandle["snapshot"] = null;
    let cursor = options.cursor;
    let status: StreamHandle["status"] = "opening";
    const listeners = new Set<(message: StreamServerMessage) => void>();
    const drop = (): void => {
      if (status !== "refused") status = "closed";
      streams.delete(id);
      mounted.streams.delete(id);
      listeners.clear();
    };
    const handle: StreamHandle = {
      get snapshot() {
        return snapshot;
      },
      get cursor() {
        return cursor;
      },
      get status() {
        return status;
      },
      on: (listener) => {
        if (status === "closed" || status === "refused") return () => {};
        listeners.add(listener);
        if (snapshot !== null) {
          try {
            listener(snapshot);
            if (
              listeners.has(listener) &&
              cursor !== undefined &&
              cursor.epoch === snapshot.epoch &&
              cursor.seq > snapshot.lastSeq
            ) {
              listener({
                type: "stream_gap",
                subscriptionId: snapshot.subscriptionId,
                epoch: cursor.epoch,
                fromSeq: snapshot.lastSeq + 1,
                toSeq: cursor.seq,
              });
            }
          } catch (error) {
            port.warn(errorText(error));
          }
        }
        return () => {
          listeners.delete(listener);
        };
      },
      close: () => {
        if (status === "closed" || !streams.has(id)) {
          status = "closed";
          return;
        }
        drop();
        if (mounted.live) {
          void send(mounted.id, mounted, "closeStream", [id]).catch(warnFailure("closeStream"));
        }
      },
    };
    const receive = (message: StreamServerMessage): void => {
      switch (message.type) {
        case "stream_snapshot":
          snapshot = message;
          cursor = { epoch: message.epoch, seq: message.lastSeq };
          status = "open";
          break;
        case "stream_frame":
          cursor = { epoch: message.epoch, seq: message.seq };
          status = "open";
          break;
        case "stream_gap":
          status = "gap";
          break;
        case "stream_reset":
          snapshot = null;
          cursor = undefined;
          status = "reset";
          break;
        case "stream_refused":
          status = "refused";
          break;
        case "stream_closed":
          status = "closed";
          break;
      }
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          port.warn(errorText(error));
        }
      }
      if (status === "refused" || status === "closed") drop();
    };
    streams.set(id, { owner: mounted, receive, drop });
    mounted.streams.add(id);
    void send(mounted.id, mounted, "openStream", [id, options, mounted.id]).catch(
      (error: unknown) => {
        if (streams.has(id)) {
          receive({ type: "stream_refused", subscriptionId: id, reason: errorText(error) });
        }
      },
    );
    return handle;
  };

  const subscribeFor = (
    mounted: Owner,
    topics: readonly ManifoldRef[],
    handler: (event: unknown) => void,
  ): (() => void) => {
    // A released client hears nothing; its status already reads `closed`.
    if (!mounted.live) return () => {};
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error("too many event subscriptions");
    subscriptionSeq += 1;
    const id = `e${String(subscriptionSeq)}`;
    subscriptions.set(id, { owner: mounted, handler });
    mounted.subscriptions.add(id);
    void send(mounted.id, mounted, "subscribe", [id, [...topics]]).catch((error: unknown) => {
      if (!subscriptions.has(id)) return;
      subscriptions.delete(id);
      mounted.subscriptions.delete(id);
      port.warn(`${mounted.label} subscription refused: ${errorText(error)}`);
    });
    return () => {
      if (!subscriptions.has(id)) return;
      subscriptions.delete(id);
      mounted.subscriptions.delete(id);
      if (mounted.live) {
        void send(mounted.id, mounted, "unsubscribe", [id]).catch(warnFailure("unsubscribe"));
      }
    };
  };

  const byteCall = async (
    mounted: Owner,
    method: "readByteChunk" | "writeByteChunk",
    pluginId: string,
    carrierId: string,
    input: ByteCarrierRequest,
    signal?: AbortSignal,
    data?: Uint8Array,
  ): Promise<unknown> => {
    const request = ByteCarrierRequestSchema.safeParse(input);
    if (
      !request.success ||
      (method === "writeByteChunk" &&
        (!(data instanceof Uint8Array) || data.byteLength !== request.data.length))
    ) {
      throw new ByteTransferError("invalid");
    }
    if (!mounted.live) throw new ByteTransferError("unavailable");
    if (signal?.aborted) throw new ByteTransferError("cancelled");
    if (byteRequests >= MAX_BYTE_REQUESTS) throw new ByteTransferError("busy");
    byteRequests += 1;
    const id = `b${String(++byteSeq)}`;
    const cancel = (): void => {
      if (!mounted.live) return; // Unmount already cancels its host-owned requests.
      void send(mounted.id, mounted, "cancelByteRequest", [id]).catch(() => {
        port.warn("byte cancellation acknowledgement unavailable");
      });
    };
    try {
      // Only the bounded visible region crosses the bridge. The caller keeps its original
      // buffer; the transport owns and transfers this one, avoiding a second structured copy.
      const owned = data === undefined ? undefined : new Uint8Array(data);
      const result = send(
        mounted.id,
        mounted,
        method,
        owned === undefined
          ? [id, pluginId, carrierId, request.data]
          : [id, pluginId, carrierId, request.data, owned],
        owned === undefined ? undefined : [owned.buffer],
      );
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const answer = await result;
      if (signal?.aborted) {
        throw new ByteTransferError(method === "writeByteChunk" ? "outcome_unknown" : "cancelled");
      }
      return answer;
    } catch (reason) {
      if (reason instanceof ByteTransferError) throw reason;
      if (reason instanceof HostCallError) {
        const refusal = ByteRefusalSchema.safeParse(reason.detail);
        if (refusal.success) throw new ByteTransferError(refusal.data);
      }
      throw new ByteTransferError(method === "writeByteChunk" ? "outcome_unknown" : "unavailable");
    } finally {
      signal?.removeEventListener("abort", cancel);
      byteRequests -= 1;
    }
  };

  const localFilesFor = (mounted: Owner): LocalFilesHandle => ({
    async read(handle, offset, length, options) {
      const signal = options?.signal;
      if (
        !LocalFileHandleSchema.safeParse(handle).success ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_BYTE_CHUNK_BYTES
      ) {
        throw new ByteTransferError("invalid");
      }
      if (!mounted.live) throw new ByteTransferError("unavailable");
      if (signal?.aborted) throw new ByteTransferError("cancelled");
      if (byteRequests >= MAX_BYTE_REQUESTS) throw new ByteTransferError("busy");
      byteRequests += 1;
      const id = `b${String(++byteSeq)}`;
      const cancel = (): void => {
        if (mounted.live)
          void send(mounted.id, mounted, "cancelByteRequest", [id]).catch(
            warnFailure("cancelLocalFile"),
          );
      };
      try {
        const pending = send(mounted.id, mounted, "readLocalFile", [id, handle, offset, length]);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        const data = await pending;
        if (signal?.aborted) throw new ByteTransferError("cancelled");
        if (!mounted.live) throw new ByteTransferError("unavailable");
        if (
          !(data instanceof Uint8Array) ||
          data.byteLength !== length ||
          !(data.buffer instanceof ArrayBuffer) ||
          data.byteOffset !== 0 ||
          data.buffer.byteLength !== length
        )
          throw new ByteTransferError("invalid");
        return data;
      } catch (error) {
        if (error instanceof ByteTransferError) throw error;
        if (error instanceof HostCallError) {
          const reason = ByteRefusalSchema.safeParse(error.detail);
          if (reason.success) throw new ByteTransferError(reason.data);
        }
        throw new ByteTransferError("unavailable");
      } finally {
        byteRequests -= 1;
        signal?.removeEventListener("abort", cancel);
      }
    },
    async release(handle) {
      if (!LocalFileHandleSchema.safeParse(handle).success) throw new ByteTransferError("invalid");
      if (!mounted.live) return;
      await send(mounted.id, mounted, "releaseLocalFile", [handle]);
    },
  });

  const clientFor = (mounted: Owner): PortableSessionHandle => ({
    action: async (name, args) =>
      (await send(mounted.id, mounted, "action", [name, args])) as ActionOutcome,
    readByteChunk: async (pluginId, carrierId, input, signal) => {
      const { offset, length } = input;
      const result = ByteReadChunkSchema.safeParse(
        await byteCall(mounted, "readByteChunk", pluginId, carrierId, input, signal),
      );
      if (
        !result.success ||
        result.data.offset !== offset ||
        result.data.data.byteLength > length
      ) {
        throw new ByteTransferError("invalid");
      }
      return result.data;
    },
    writeByteChunk: async (pluginId, carrierId, input, data, signal) => {
      const { offset, sequence, length } = input;
      const result = ByteWriteReceiptSchema.safeParse(
        await byteCall(mounted, "writeByteChunk", pluginId, carrierId, input, signal, data),
      );
      if (
        !result.success ||
        result.data.offset < offset + length ||
        result.data.sequence !== sequence ||
        result.data.acceptedBytes !== length
      ) {
        throw new ByteTransferError("outcome_unknown");
      }
      return result.data;
    },
    place: async (ref, destination) =>
      (await send(mounted.id, mounted, "place", [ref, destination])) as PlaceOutcome,
    selfCaps: () => mounted.context.caps,
    machines: async () =>
      (await send(mounted.id, mounted, "machines", [])) as readonly MachineSummary[],
    resolve: async (uri) => (await send(mounted.id, mounted, "resolve", [uri])) as ResolveResponse,
    openStream: (options) => streamFor(mounted, options),
    openTerminal: async (options) =>
      (await send(mounted.id, mounted, "openTerminal", [options])) as TerminalInfo,
    sendTerminalInput: (terminalId, data) => {
      void send(mounted.id, mounted, "sendTerminalInput", [terminalId, data]).catch(
        warnFailure("sendTerminalInput"),
      );
    },
    terminalsByContainer: async () =>
      (await send(
        mounted.id,
        mounted,
        "terminalsByContainer",
        [],
      )) as readonly ContainerTerminalSummary[],
    subscribe: (topics, handler) => subscribeFor(mounted, topics, handler),
    get status() {
      return mounted.live ? mounted.context.status : "closed";
    },
    on: (_event, fn) => {
      if (!mounted.live) return () => {};
      mounted.statusListeners.add(fn);
      return () => {
        mounted.statusListeners.delete(fn);
      };
    },
    get hidden() {
      return mounted.context.hidden;
    },
    onVisibilityChange: (fn) => {
      if (!mounted.live) return () => {};
      mounted.visibilityListeners.add(fn);
      return () => {
        mounted.visibilityListeners.delete(fn);
      };
    },
  });

  /** Host identity changes only with the facts it carries; status and caps are read live. */
  const refreshHost = (mounted: Mounted): void => {
    const key = hostKeyOf(mounted.context);
    if (key === mounted.hostKey) return;
    mounted.hostKey = key;
    mounted.host = hostOf(
      mounted.context,
      mounted.client,
      mounted.navigate,
      mounted.authoring,
      mounted.localFiles,
    );
  };

  const render = (mounted: Mounted): void => {
    const element = mounted.element;
    const rendered =
      mounted.kind === "element"
        ? createElement(mounted.component as ComponentType<PortableElementProps>, {
            host: mounted.host,
            ...mounted.element!,
            edit: {
              writable: mounted.context.elementWritable === true,
              patch: async (patch) => {
                await send(mounted.id, mounted, "patchElement", [
                  { expected: element!.data, patch },
                ]);
              },
            },
          })
        : createElement(
            mounted.component as ComponentType<PortablePanelProps>,
            mounted.kind === "panel"
              ? {
                  host: mounted.host,
                  arg: mounted.arg,
                  input: mounted.input,
                  onResult: mounted.onResult,
                }
              : { host: mounted.host },
          );
    mounted.root.render(createElement(FrameModeProvider, null, rendered));
  };

  /**
   * Ends an instance's host-side life. A page `unmount` already released its resources, so
   * only local state goes; a guest fault tells the page to close what the instance owns first.
   */
  const retire = (mounted: Owner, releaseOnHost: boolean): void => {
    instances.delete(mounted.id);
    if (releaseOnHost) {
      for (const id of mounted.streams) {
        void send(mounted.id, null, "closeStream", [id]).catch(warnFailure("closeStream"));
      }
      for (const id of mounted.subscriptions) {
        void send(mounted.id, null, "unsubscribe", [id]).catch(warnFailure("unsubscribe"));
      }
    }
    mounted.live = false;
    for (const id of [...mounted.streams]) streams.get(id)?.drop();
    for (const id of mounted.subscriptions) subscriptions.delete(id);
    mounted.subscriptions.clear();
    for (const [id, call] of pending) {
      if (call.owner !== mounted) continue;
      pending.delete(id);
      retired.add(id);
      call.reject(new Error(`${mounted.label} is unmounted`));
    }
    for (const id of retired) {
      if (retired.size <= MAX_RETIRED_CALLS) break;
      retired.delete(id);
    }
    const listeners = [...mounted.statusListeners];
    mounted.statusListeners.clear();
    mounted.visibilityListeners.clear();
    // Anything still listening to this client (a feed another reader shares) learns it is gone.
    for (const listener of listeners) {
      try {
        listener("closed");
      } catch (error) {
        port.warn(errorText(error));
      }
    }
  };

  const failMounted = (mounted: Mounted, error: Error): void => {
    if (instances.get(mounted.id) !== mounted) return;
    retire(mounted, true);
    faulted.add(mounted.id);
    fault(mounted.id, `${mounted.label} failed: ${error.message}`);
    // React reported this from inside its own work; teardown runs once that work returns.
    queueMicrotask(() => mounted.root.unmount());
  };

  const onMount = (frame: Extract<WebIsolateHostFrame, { t: "mount" }>): void => {
    if (!initialized) {
      fault(frame.instance, "mount before init");
      return;
    }
    if (instances.has(frame.instance) || faulted.has(frame.instance)) {
      fault(frame.instance, `instance "${frame.instance}" is already mounted`);
      return;
    }
    const kind: Kind = frame.kind ?? "panel";
    const label = `${kind} "${frame.panel}"`;
    const registry =
      kind === "panel" ? def.panels : kind === "section" ? def.sections : def.elements;
    const component =
      registry !== undefined && Object.hasOwn(registry, frame.panel)
        ? registry[frame.panel]
        : undefined;
    if (component === undefined) {
      fault(frame.instance, `no such ${label}`);
      return;
    }
    if (frame.context === undefined) {
      fault(frame.instance, `${label} was mounted without its host context`);
      return;
    }
    if (
      (kind !== "panel" &&
        (frame.arg !== undefined ||
          frame.input !== undefined ||
          frame.acceptsResult !== undefined)) ||
      (kind === "element") !== (frame.element !== undefined)
    ) {
      fault(frame.instance, `${label} has incompatible mount data`);
      return;
    }
    const instance = frame.instance;
    const owner: Owner = {
      id: instance,
      label,
      kind,
      context: frame.context,
      live: true,
      streams: new Set(),
      subscriptions: new Set(),
      statusListeners: new Set(),
      visibilityListeners: new Set(),
    };
    const client = clientFor(owner);
    const localFiles = localFilesFor(owner);
    const navigate = (uri: string): void => {
      void send(instance, owner, "navigate", [uri]).catch(warnFailure("navigate"));
    };
    const authoring: AuthoringHandle = {
      createTerminal: async (machine, runtime) =>
        (await send(instance, owner, "createTerminal", [
          machine === undefined ? null : machine.id,
          runtime ?? null,
        ])) as TerminalInfo | null,
    };
    const root: UiRoot = createUiRoot({
      // The tree was validated against the vocabulary before it got here.
      commit: (tree) => port.post({ t: "render", instance, tree }),
      fault: (error) => {
        const current = instances.get(instance);
        if (current?.root === root) failMounted(current, error);
      },
      report: (error) => port.warn(`${label}: ${errorText(error)}`),
    });
    let resultDelivered = false;
    const onResult =
      frame.acceptsResult === true
        ? (result: PanelArg): void => {
            if (!owner.live || instances.get(instance) !== mounted || resultDelivered) return;
            post({ t: "panel_result", instance, result });
            resultDelivered = true;
          }
        : undefined;
    const mounted: Mounted = Object.assign(owner, {
      component: component as Contribution,
      root,
      client,
      navigate,
      authoring,
      localFiles,
      host: hostOf(frame.context, client, navigate, authoring, localFiles),
      hostKey: hostKeyOf(frame.context),
      arg: frame.arg,
      argKey: JSON.stringify(frame.arg),
      input: frame.input,
      onResult,
      element: frame.element,
      elementKey: JSON.stringify(frame.element),
    });
    instances.set(instance, mounted);
    render(mounted);
  };

  const onContext = (frame: Extract<WebIsolateHostFrame, { t: "context" }>): void => {
    const mounted = instances.get(frame.instance);
    if (mounted === undefined) {
      if (!faulted.has(frame.instance)) {
        port.warn(`context for unknown instance "${frame.instance}"; ignored`);
      }
      return;
    }
    if (
      (mounted.kind !== "panel" && frame.arg !== undefined) ||
      (mounted.kind === "element") !== (frame.element !== undefined) ||
      (mounted.element !== undefined && mounted.element.id !== frame.element?.id)
    ) {
      failMounted(mounted, new Error("mounted contribution identity or payload kind changed"));
      return;
    }
    const previous = mounted.context;
    mounted.context = frame.context;
    refreshHost(mounted);
    const argKey = JSON.stringify(frame.arg);
    if (argKey !== mounted.argKey) {
      mounted.argKey = argKey;
      mounted.arg = frame.arg;
    }
    const elementKey = JSON.stringify(frame.element);
    if (elementKey !== mounted.elementKey) {
      mounted.elementKey = elementKey;
      mounted.element = frame.element;
    }
    render(mounted);
    if (previous.status !== frame.context.status) {
      for (const listener of [...mounted.statusListeners]) {
        try {
          listener(frame.context.status);
        } catch (error) {
          port.warn(errorText(error));
        }
      }
    }
    if (previous.hidden !== frame.context.hidden) {
      for (const listener of [...mounted.visibilityListeners]) {
        try {
          listener();
        } catch (error) {
          port.warn(errorText(error));
        }
      }
    }
  };

  const onUnmount = (frame: Extract<WebIsolateHostFrame, { t: "unmount" }>): void => {
    faulted.delete(frame.instance);
    const mounted = instances.get(frame.instance);
    if (mounted === undefined) return;
    retire(mounted, false);
    try {
      mounted.root.unmount();
    } catch (error) {
      port.warn(`${mounted.label} failed to unmount: ${errorText(error)}`);
    }
  };

  const onEvent = (frame: Extract<WebIsolateHostFrame, { t: "event" }>): void => {
    const mounted = instances.get(frame.instance);
    if (mounted === undefined) {
      if (!faulted.has(frame.instance)) {
        port.warn(`event "${frame.event}" for unknown instance "${frame.instance}"; ignored`);
      }
      return;
    }
    const refusal = mounted.root.event(frame.event, frame.payload);
    if (refusal !== null) {
      port.warn(`${mounted.label} refused event "${frame.event}": ${refusal}`);
    }
  };

  const onStream = (frame: Extract<WebIsolateHostFrame, { t: "stream" }>): void => {
    const stream = streams.get(frame.id);
    if (stream === undefined) return;
    stream.receive(frame.message);
    if (stream.owner.live) {
      void send(stream.owner.id, stream.owner, "ackStream", [frame.id]).catch(
        warnFailure("ackStream"),
      );
    }
  };

  /** One invalidation per subscription is outstanding until acknowledged; nothing rides it. */
  const onNotification = (frame: Extract<WebIsolateHostFrame, { t: "notification" }>): void => {
    const subscription = subscriptions.get(frame.id);
    if (subscription === undefined) return;
    try {
      subscription.handler(undefined);
    } catch (error) {
      port.warn(`${subscription.owner.label}: ${errorText(error)}`);
    }
    if (subscriptions.has(frame.id) && subscription.owner.live) {
      void send(subscription.owner.id, subscription.owner, "ackEvent", [frame.id]).catch(
        warnFailure("ackEvent"),
      );
    }
  };

  const onReply = (frame: Extract<WebIsolateHostFrame, { t: "reply" }>): void => {
    const waiting = pending.get(frame.id);
    if (waiting === undefined) {
      if (!retired.delete(frame.id)) port.warn(`reply for unknown call "${frame.id}"; ignored`);
      return;
    }
    pending.delete(frame.id);
    if (frame.ok) waiting.resolve(frame.result);
    else waiting.reject(new HostCallError(waiting.method, frame.error));
  };

  port.onMessage((data) => {
    const frame = WebIsolateHostFrameSchema.safeParse(data);
    if (!frame.success) {
      port.warn(`unknown page frame ignored: ${issueText(frame.error)}`);
      return;
    }
    const page = frame.data;
    switch (page.t) {
      case "init": {
        if (page.pluginId !== def.id) {
          fault(undefined, `this Worker serves "${def.id}", not "${page.pluginId}"`);
          return;
        }
        initialized = true;
        try {
          post({
            t: "ready",
            panels: Object.keys(def.panels ?? {}),
            sections: Object.keys(def.sections ?? {}),
            elements: Object.keys(def.elements ?? {}),
            hardenedContract: HARDENED_CONTRACT_VERSION,
          });
        } catch (error) {
          fault(undefined, `contribution ids are outside the vocabulary: ${errorText(error)}`);
        }
        return;
      }
      case "mount":
        onMount(page);
        return;
      case "context":
        onContext(page);
        return;
      case "notification":
        onNotification(page);
        return;
      case "unmount":
        onUnmount(page);
        return;
      case "event":
        onEvent(page);
        return;
      case "stream":
        onStream(page);
        return;
      case "reply":
        onReply(page);
        return;
      default: {
        const never: never = page;
        port.warn(`unhandled page frame ${String(never)}`);
      }
    }
  });
}

/**
 * The dedicated Worker's own messaging scope; null in a document, where `postMessage` would
 * address the window instead of the page that started this Worker.
 */
function workerPort(): WebGuestPort | null {
  const scope: Record<string, unknown> = globalThis;
  const postMessage = scope["postMessage"];
  const addEventListener = scope["addEventListener"];
  if (
    scope["document"] !== undefined ||
    typeof postMessage !== "function" ||
    typeof addEventListener !== "function"
  ) {
    return null;
  }
  const listen = addEventListener as (
    type: string,
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  return {
    post: (frame, transfer) => {
      if (transfer === undefined) postMessage(frame);
      else postMessage(frame, transfer);
    },
    onMessage: (listener) => listen("message", (event) => listener(event.data)),
    warn: (line) => console.error(line),
  };
}

/**
 * THE PORTABLE ENTRY'S ONE STATEMENT: the packer's generated `web.worker.js` imports the
 * author's default export and hands it here. Anywhere but a dedicated Worker it refuses.
 */
export function startWebWorker(def: unknown): void {
  const port = workerPort();
  if (port === null) throw new Error("the portable web runtime runs only in a dedicated Worker");
  attachWebGuest(def as ReactWebPluginDef, port);
}
