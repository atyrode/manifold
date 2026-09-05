import type { PluginLifecycle } from "@manifold/plugin";
import type { PluginLifecycleState, PluginManifest } from "@manifold/protocol";
import type { ServerPluginDef } from "../plugin-host.ts";

/**
 * THE SEAM between the plugin host and the isolation runner (ADR 0016 §1, §6). The host owns
 * the roster, the ladder and the trace; the runner owns one child process per installed
 * plugin and turns it into an ordinary `ServerPluginDef` — the same shape a first-party
 * package registers — so nothing past this file knows whether a handler runs in-realm or
 * across a process boundary. This file is types and two error classes and nothing else:
 * `plugin-host.ts` imports it, and the runner's own modules implement it.
 */

/**
 * Where one plugin's child is, as the roster mirrors it. `stopped` is both "never spawned"
 * and "evicted for idleness" — either way the next dispatch spawns. `crashed` is terminal
 * until `unload` + `load`: the crash budget was spent and respawning stopped (§6).
 */
export type IsolateState = "stopped" | "starting" | "running" | "crashed";

/** An installed row as the runner needs it: identity, declaration, and where its code sits. */
export interface InstalledPluginRef {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** The extracted bundle directory containing `server.js` (`PLUGIN_BUNDLE_SERVER_FILE`). */
  readonly dir: string;
}

/**
 * What a load yields: the def the host assembles — its `actions` are the child's own report
 * with `z.unknown()` inputs because the child validates, its `handlers` are proxies — and the
 * lifecycle proxies for exactly the hooks the child declared. `def.lifecycle` is the same
 * object; it is named twice so a caller that assembles the def and one that runs hooks each
 * reach for the field that says what it is.
 */
export interface IsolateLoadResult {
  readonly def: ServerPluginDef;
  readonly lifecycle: PluginLifecycle;
}

export interface IsolateRunner {
  /**
   * Spawns the child, awaits `loaded` within `ISOLATE_DISPATCH_DEADLINE_MS`; rejects with
   * {@link IsolateLoadError} on `load_failed`, a timeout, or an exit before the handshake,
   * and the child is killed. Loading an id that is already loaded unloads it first.
   */
  load(ref: InstalledPluginRef): Promise<IsolateLoadResult>;
  /** Sends `shutdown`, kills after 2 s; every in-flight request answers `unavailable`. */
  unload(pluginId: string): Promise<void>;
  /** `stopped` for an id this runner never loaded. */
  state(pluginId: string): IsolateState;
  /** Fires on every transition; returns the unsubscribe. */
  onState(listener: (pluginId: string, state: IsolateState, detail?: string) => void): () => void;
  /** Server shutdown: unloads every child. */
  close(): Promise<void>;
}

/**
 * The two ladder rungs a proxy handler answers by THROWING rather than returning: the child
 * graded the arguments (`invalid_args`, the schema lives where the code lives), or the child
 * is not there to grade anything (`unavailable`: crashed past its budget, or silent past the
 * deadline). The host catches this class in `run()` and routes it through the same `refuse`
 * path every other rung takes, so an isolate's refusal is traced exactly like an in-realm
 * one (invariant 5). A handler's own `{ refused }` still returns as data, as it always has.
 */
export class IsolateDenial extends Error {
  readonly rule: "invalid_args" | "unavailable";

  constructor(rule: "invalid_args" | "unavailable", message: string) {
    super(message);
    this.name = "IsolateDenial";
    this.rule = rule;
  }
}

/** `load` could not reach a serving child; the message says why (`load_failed`, timeout, exit). */
export class IsolateLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolateLoadError";
  }
}

/**
 * The roster's word for a runner state, or nothing when the row has nothing to say: a
 * running or idle-evicted child is `ok` as far as the roster is concerned, so only the two
 * states the row publishes (`PLUGIN_LIFECYCLE_STATES`) map.
 */
export function isolateLifecycleState(state: IsolateState): PluginLifecycleState | undefined {
  switch (state) {
    case "starting":
      return "isolate_starting";
    case "crashed":
      return "isolate_crashed";
    case "stopped":
    case "running":
      return undefined;
  }
}
