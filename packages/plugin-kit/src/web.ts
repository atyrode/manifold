import {
  UiNodeSchema,
  WebIsolateHostFrameSchema,
  WebIsolateWorkerFrameSchema,
  type ActionOutcome,
  type Cap,
  type ContainerTerminalSummary,
  type MachineSummary,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementDestination,
  type PlacementRef,
  type Principal,
  type ResolveResponse,
  type TerminalEnv,
  type TerminalInfo,
  type TerminalProgram,
  type UiNode,
  type WebHostMethod,
  type WebIsolateHostFrame,
  type WebIsolateWorkerFrame,
} from "@manifold/protocol";
import type { z } from "zod";
import { HostCallError } from "./errors.ts";

/**
 * THE WEB GUEST RUNTIME (ADR 0016 §1, §3).
 *
 * An installed plugin's web half runs in a dedicated `Worker` the engine creates from
 * `GET /api/plugins/<id>/web.js`. This module is the worker's end of the `postMessage`
 * channel: it answers `init`, `mount`, `event` and `unmount`, and it renders by POSTING A TREE
 * — never by touching a DOM it does not have. A panel is a small program: `init` produces a
 * state, `view` projects it to a tree of the closed vocabulary, `update` folds a named
 * callback into the next state, and `subscribe` is where a timer or a poll lives. The host
 * services a program reaches are `call` frames the page serves from the panel's REAL host
 * services, which is how a worker dispatches with the viewer's authority without ever holding
 * the viewer's token.
 */

// ---------------------------------------------------------------------------- the definition

/** What `place()` answers, restated over protocol types (the kit cannot import the SDK). */
export type GuestWebPlaceOutcome =
  | { readonly ok: true; readonly result: PlaceResponse }
  | { readonly ok: false; readonly denial: PlacementDenial };

/** The `terminal_open` request, as `SessionClient.openTerminal` takes it. */
export interface OpenTerminalOptions {
  readonly elementId: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string | undefined;
  readonly machineId?: string | undefined;
  readonly placement?: "tile" | undefined;
  readonly program?: TerminalProgram | undefined;
  readonly env?: TerminalEnv | undefined;
}

/**
 * The host, as a program sees it: the viewer's identity as data, and the nine
 * `WEB_HOST_METHODS` as promises. Each has the semantics of the engine's `SessionHandle`
 * method of the same name.
 */
export interface GuestHost {
  readonly principal: Principal;
  readonly caps: readonly Cap[];
  readonly containerId: string | null;
  /** Invoke an action by its FULL name; a denial is data, never a throw. */
  action(name: string, args: unknown): Promise<ActionOutcome>;
  place(ref: PlacementRef, destination: PlacementDestination): Promise<GuestWebPlaceOutcome>;
  selfCaps(): Promise<readonly Cap[]>;
  machines(): Promise<readonly MachineSummary[]>;
  resolve(uri: string): Promise<ResolveResponse>;
  navigate(uri: string): Promise<void>;
  openTerminal(options: OpenTerminalOptions): Promise<TerminalInfo>;
  sendTerminalInput(terminalId: string, data: string): Promise<void>;
  terminalsByContainer(): Promise<readonly ContainerTerminalSummary[]>;
}

/** A named callback firing on a mounted panel: the control's event word and its payload. */
export interface PanelEvent {
  readonly event: string;
  readonly payload?: unknown;
}

/**
 * One panel as a program over its own state. Method syntax on purpose: it is what lets a
 * `PanelProgram<{ count: number }>` sit in a record typed over `unknown` states.
 */
export interface PanelProgram<S> {
  init(host: GuestHost): S | Promise<S>;
  view(state: S): UiNode;
  update(state: S, event: PanelEvent, host: GuestHost): S | Promise<S>;
  /** Timers and polling live here; the returned function stops them at unmount. */
  subscribe?(host: GuestHost, emit: (event: PanelEvent) => void): () => void;
}

/** Identity helper so `S` is inferred once, at the definition site. */
export function definePanel<S>(program: PanelProgram<S>): PanelProgram<S> {
  return program;
}

export interface WebPluginDef {
  readonly id: string;
  /** Keyed by LOCAL panel id, the same ids the manifest's `contributes.panels` declares. */
  readonly panels: Readonly<Record<string, PanelProgram<unknown>>>;
}

// ---------------------------------------------------------------------------- the port

/** The worker's end of `postMessage`, as three verbs; tests bind them to an in-memory pair. */
export interface WebGuestPort {
  post(frame: WebIsolateWorkerFrame): void;
  onMessage(listener: (data: unknown) => void): void;
  warn(line: string): void;
}

/** The dedicated worker scope, when this module runs inside one; null when merely imported. */
function workerPort(): WebGuestPort | null {
  const scope: Record<string, unknown> = globalThis;
  const WorkerGlobalScope = scope["WorkerGlobalScope"];
  if (typeof WorkerGlobalScope !== "function" || !(scope["self"] instanceof WorkerGlobalScope)) {
    return null;
  }
  const postMessage = scope["postMessage"] as (message: unknown) => void;
  const addEventListener = scope["addEventListener"] as (
    type: string,
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  return {
    post: (frame) => postMessage(frame),
    onMessage: (listener) => addEventListener("message", (event) => listener(event.data)),
    warn: (line) => console.error(line),
  };
}

// ---------------------------------------------------------------------------- the runtime

interface Instance {
  readonly panel: string;
  readonly program: PanelProgram<unknown>;
  state: unknown;
  stop: (() => void) | null;
  /** Events fold in order: an `update` still awaiting cannot be overtaken by the next one. */
  queue: Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
    .join("; ");
}

/**
 * Wires a definition to a port and starts answering page frames. `defineWebPlugin` calls
 * this with the worker scope; tests call it with a fake page.
 */
export function attachWebGuest(def: WebPluginDef, port: WebGuestPort): void {
  const pending = new Map<
    string,
    { readonly method: WebHostMethod; resolve(value: unknown): void; reject(error: Error): void }
  >();
  const instances = new Map<string, Instance>();
  let host: GuestHost | null = null;
  let seq = 0;

  /** Every outgoing frame is parsed first: a kit bug fails here, loudly, never as a malformed frame. */
  const post = (frame: WebIsolateWorkerFrame): void => {
    port.post(WebIsolateWorkerFrameSchema.parse(frame));
  };

  const fault = (instance: string | undefined, error: string): void => {
    post(instance === undefined ? { t: "fault", error } : { t: "fault", instance, error });
  };

  const call = (method: WebHostMethod, args: readonly unknown[]): Promise<unknown> => {
    seq += 1;
    const id = `c${String(seq)}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pending.set(id, { method, resolve, reject });
    post({ t: "call", id, method, args: [...args] });
    return promise;
  };

  const hostFor = (init: Extract<WebIsolateHostFrame, { t: "init" }>): GuestHost => ({
    principal: init.principal,
    caps: init.caps,
    containerId: init.containerId,
    action: async (name, args) => (await call("action", [name, args])) as ActionOutcome,
    place: async (ref, destination) =>
      (await call("place", [ref, destination])) as GuestWebPlaceOutcome,
    selfCaps: async () => (await call("selfCaps", [])) as readonly Cap[],
    machines: async () => (await call("machines", [])) as readonly MachineSummary[],
    resolve: async (uri) => (await call("resolve", [uri])) as ResolveResponse,
    navigate: async (uri) => {
      await call("navigate", [uri]);
    },
    openTerminal: async (options) => (await call("openTerminal", [options])) as TerminalInfo,
    sendTerminalInput: async (terminalId, data) => {
      await call("sendTerminalInput", [terminalId, data]);
    },
    terminalsByContainer: async () =>
      (await call("terminalsByContainer", [])) as readonly ContainerTerminalSummary[],
  });

  /** Projects an instance's state and posts it; a throw or a tree outside the vocabulary is a fault. */
  const render = (id: string, instance: Instance): void => {
    let projected: unknown;
    try {
      projected = instance.program.view(instance.state);
    } catch (error) {
      fault(id, `panel "${instance.panel}" failed to render: ${errorText(error)}`);
      return;
    }
    const tree = UiNodeSchema.safeParse(projected);
    if (!tree.success) {
      fault(
        id,
        `panel "${instance.panel}" rendered a tree outside the vocabulary: ${issueText(tree.error)}`,
      );
      return;
    }
    post({ t: "render", instance: id, tree: tree.data });
  };

  const fold = (id: string, instance: Instance, event: PanelEvent, viewer: GuestHost): void => {
    instance.queue = instance.queue.then(async () => {
      // Unmounted while an earlier update was still awaiting: nothing to fold into.
      if (instances.get(id) !== instance) return;
      try {
        instance.state = await instance.program.update(instance.state, event, viewer);
      } catch (error) {
        fault(id, `panel "${instance.panel}" failed on "${event.event}": ${errorText(error)}`);
        return;
      }
      if (instances.get(id) === instance) render(id, instance);
    });
  };

  const onMount = async (frame: Extract<WebIsolateHostFrame, { t: "mount" }>): Promise<void> => {
    if (host === null) {
      fault(frame.instance, "mount before init");
      return;
    }
    const program = def.panels[frame.panel];
    if (program === undefined) {
      fault(frame.instance, `no such panel "${frame.panel}"`);
      return;
    }
    const viewer = host;
    const instance: Instance = {
      panel: frame.panel,
      program,
      state: undefined,
      stop: null,
      queue: Promise.resolve(),
    };
    instances.set(frame.instance, instance);
    try {
      instance.state = await program.init(viewer);
    } catch (error) {
      instances.delete(frame.instance);
      fault(frame.instance, `panel "${frame.panel}" failed to start: ${errorText(error)}`);
      return;
    }
    // Unmounted before init settled: the page has already moved on.
    if (instances.get(frame.instance) !== instance) return;
    render(frame.instance, instance);
    if (program.subscribe === undefined) return;
    try {
      instance.stop = program.subscribe(viewer, (event) => {
        if (instances.get(frame.instance) === instance) fold(frame.instance, instance, event, viewer);
      });
    } catch (error) {
      fault(frame.instance, `panel "${frame.panel}" failed to subscribe: ${errorText(error)}`);
    }
  };

  const onUnmount = (frame: Extract<WebIsolateHostFrame, { t: "unmount" }>): void => {
    const instance = instances.get(frame.instance);
    if (instance === undefined) return;
    instances.delete(frame.instance);
    try {
      instance.stop?.();
    } catch (error) {
      port.warn(`panel "${instance.panel}" failed to stop: ${errorText(error)}`);
    }
  };

  const onReply = (frame: Extract<WebIsolateHostFrame, { t: "reply" }>): void => {
    const waiting = pending.get(frame.id);
    if (waiting === undefined) {
      port.warn(`reply for unknown call "${frame.id}"; ignored`);
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
        host = hostFor(page);
        try {
          post({ t: "ready", panels: Object.keys(def.panels) });
        } catch (error) {
          fault(undefined, `panel ids are outside the vocabulary: ${errorText(error)}`);
        }
        return;
      }
      case "mount":
        void onMount(page);
        return;
      case "event": {
        const instance = instances.get(page.instance);
        if (instance === undefined || host === null) {
          port.warn(`event "${page.event}" for unknown instance "${page.instance}"; ignored`);
          return;
        }
        fold(
          page.instance,
          instance,
          page.payload === undefined ? { event: page.event } : { event: page.event, payload: page.payload },
          host,
        );
        return;
      }
      case "unmount":
        onUnmount(page);
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
 * THE AUTHORING ENTRY POINT. Call it once at the top level of your `web.ts`. When the module
 * runs inside a dedicated worker it wires `postMessage` and starts serving; imported anywhere
 * else (a test, `pack`) it is inert.
 */
export function defineWebPlugin(def: WebPluginDef): void {
  const port = workerPort();
  if (port === null) return;
  attachWebGuest(def, port);
}
