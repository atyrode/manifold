/** A Vite-local lifecycle event, never a Manifold session frame or native channel. */
export const PLUGIN_REFRESH_CANCEL_EVENT = "manifold:plugin-refresh-cancel";
export const PLUGIN_REFRESH_READY_EVENT = "manifold:plugin-refresh-ready";

/** Browser leases preserve real types; React Refresh owns families and hook compatibility. */
export const pluginRefreshRuntime = String.raw`
import { updateStyle as applyStyle, removeStyle as discardStyle, ErrorOverlay } from "/@vite/client";

const sources = new Map();
const sheets = new Map();
const registrations = new WeakMap();
let ended = false;
let transportLive = false;
let graphFailed = false;

function state(id) {
  let value = sources.get(id);
  if (!value) {
    value = { id, raw: null, definition: undefined, listeners: new Set(), leases: 0, cancelled: ended, configured: false, stylesReady: false, failed: false, error: null };
    sources.set(id, value);
  }
  return value;
}

function definition(value) {
  return value.cancelled ? null : transportLive && value.stylesReady ? value.definition : undefined;
}

function notify(value) {
  for (const listener of value.listeners) listener(definition(value));
}

export function registerComponent(runtime, type, id) {
  runtime.register(type, id);
  if (type && (typeof type === "function" || typeof type === "object")) registrations.set(type, id);
}

function retainTypes(previous, next) {
  if (Object.is(previous, next) || !previous || !next) return next;
  if ((typeof next === "function" || typeof next === "object") && registrations.has(next) && registrations.get(previous) === registrations.get(next)) return previous;
  if (typeof next !== "object" || typeof previous !== "object") return next;
  if (Array.isArray(next) !== Array.isArray(previous)) return next;
  if (!Array.isArray(next) && Object.getPrototypeOf(next) !== Object.prototype) return next;
  let result = next;
  for (const key of Object.keys(next)) {
    const held = retainTypes(previous[key], next[key]);
    if (held !== next[key]) {
      if (result === next) result = Array.isArray(next) ? [...next] : { ...next };
      result[key] = held;
    }
  }
  return result;
}

export function publish(id, next) {
  const value = state(id);
  if (value.cancelled || value.raw === next) return;
  if (!next || typeof next !== "object" || next.id !== id) {
    cancel(id, "source_id_mismatch");
    return;
  }
  // Old real types keep their state until the standard debounced Refresh advances their families.
  value.definition = retainTypes(value.definition, next);
  value.raw = next;
  if (value.stylesReady) {
    value.failed = false;
    value.error?.remove();
    value.error = null;
  }
  notify(value);
}

export function acceptDescriptor(runtime, filename, id, before, after) {
  const stable = before?.default ?? null;
  const incompatible = runtime.validateRefreshBoundaryAndEnqueueUpdate(filename, { ...before, default: stable }, { ...after, default: stable });
  if (incompatible) {
    const value = state(id);
    if (!value.cancelled) {
      value.definition = value.raw;
      notify(value);
    }
  }
}

export function graphError(id, reason) {
  const value = state(id);
  if (value.cancelled) return;
  graphFailed = true;
  value.failed = true;
  console.error("plugin-refresh:", id, reason);
  if (!document.querySelector("vite-error-overlay")) {
    value.error = new ErrorOverlay({ message: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined });
    document.body.appendChild(value.error);
  }
}

export function stylesLoaded(id) {
  const value = state(id);
  if (value.cancelled || value.stylesReady) return;
  value.stylesReady = true;
  if (value.raw) {
    value.failed = false;
    value.error?.remove();
    value.error = null;
  }
  notify(value);
}

export function sourceModule(id, stylesheet) {
  const value = state(id);
  if (!value.configured) {
    value.configured = true;
    value.stylesReady = !stylesheet;
  }
  return {
    get default() { return definition(value); },
    get initialFailurePending() { return !value.cancelled && value.failed && (!value.raw || !value.stylesReady); },
    mountStyles() {
      if (value.cancelled) return () => {};
      value.leases++;
      for (const [key, sheet] of sheets) if (sheet.owners.includes(id)) applyStyle(key, sheet.css);
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        value.leases = Math.max(0, value.leases - 1);
        for (const [key, sheet] of sheets) if (sheet.owners.includes(id) && !sheet.owners.some((owner) => state(owner).leases > 0)) discardStyle(key);
      };
    },
    subscribe(listener) {
      value.listeners.add(listener);
      listener(definition(value));
      return () => value.listeners.delete(listener);
    },
  };
}

export function updateStyles(owners, key, css) {
  sheets.set(key, { owners, css });
  if (owners.some((id) => !state(id).cancelled && state(id).leases > 0)) applyStyle(key, css);
}
export function removeStyles(key) { sheets.delete(key); discardStyle(key); }

export function cancel(id, reason) {
  const value = state(id);
  if (value.cancelled) return;
  value.cancelled = true;
  value.leases = 0;
  value.error?.remove();
  value.error = null;
  for (const [key, sheet] of sheets) if (sheet.owners.includes(id) && !sheet.owners.some((owner) => state(owner).leases > 0)) discardStyle(key);
  notify(value);
  console.warn("plugin-refresh:", id, reason);
}

function end(reason) {
  ended = true;
  transportLive = false;
  for (const id of sources.keys()) cancel(id, reason);
}

if (import.meta.hot) {
  const nonce = crypto.randomUUID();
  import.meta.hot.on(${JSON.stringify(PLUGIN_REFRESH_READY_EVENT)}, data => {
    if (ended || transportLive || data?.nonce !== nonce) return;
    transportLive = true;
    for (const value of sources.values()) notify(value);
  });
  import.meta.hot.on("vite:beforeUpdate", () => {
    if (!graphFailed) return;
    // The native overlay stays visible until correction, without first-update document reload.
    for (const overlay of document.querySelectorAll("vite-error-overlay")) overlay.remove();
    for (const value of sources.values()) value.error = null;
    graphFailed = false;
  });
  import.meta.hot.on(${JSON.stringify(PLUGIN_REFRESH_CANCEL_EVENT)}, ({ ids, reason }) => { for (const id of ids) cancel(id, reason); });
  import.meta.hot.on("vite:ws:disconnect", () => end("disconnected"));
  import.meta.hot.on("vite:beforeFullReload", () => end("restart_required"));
  import.meta.hot.send(${JSON.stringify(PLUGIN_REFRESH_READY_EVENT)}, { nonce });
}
`;
