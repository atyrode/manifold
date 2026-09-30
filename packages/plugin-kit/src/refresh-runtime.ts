/** A Vite-local lifecycle event, never a Manifold session frame or native channel. */
export const PLUGIN_REFRESH_CANCEL_EVENT = "manifold:plugin-refresh-cancel";

/** Browser lease adapter; Vite and React Refresh retain ownership of CSS updates and families. */
export const pluginRefreshRuntime = String.raw`
import * as React from "react";
import * as Refresh from "/@react-refresh";
import { updateStyle as applyStyle, removeStyle as discardStyle } from "/@vite/client";

const sources = new Map();
const sheets = new Map();
const componentSlots = { panels: true, sections: true, elements: true, routes: true, renderers: true, overlays: true, workspaceOverlays: true, terminals: true };

function state(id) {
  let value = sources.get(id);
  if (!value) {
    value = { id, raw: null, definition: null, listeners: new Set(), leases: 0, cancelled: false, components: new Map(), previous: null };
    sources.set(id, value);
  }
  return value;
}

function notify(value) {
  for (const listener of value.listeners) listener(value.cancelled ? null : value.definition);
}

function compatible(before, after, slot = false) {
  if (slot && Refresh.isLikelyComponentType(before) && Refresh.isLikelyComponentType(after)) return true;
  if (Object.is(before, after)) return true;
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
  if (Array.isArray(before) !== Array.isArray(after)) return false;
  const left = Object.keys(before).sort();
  const right = Object.keys(after).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] && compatible(before[key], after[key], slot || componentSlots[key] === true));
}

function bridge(value, definition, path = "", slot = false) {
  if (slot && Refresh.isLikelyComponentType(definition)) {
    Refresh.register(definition, value.id + " descriptor " + path);
    let cell = value.components.get(path);
    if (!cell) {
      cell = { current: definition, wrapper: null };
      const component = (props) => React.createElement(cell.current, props);
      component.displayName = "PluginRefresh(" + path + ")";
      cell.wrapper = component;
      value.components.set(path, cell);
    }
    cell.current = definition;
    return cell.wrapper;
  }
  if (!definition || typeof definition !== "object") return definition;
  const result = Array.isArray(definition) ? [] : {};
  for (const key of Object.keys(definition)) result[key] = bridge(value, definition[key], path + "/" + key, slot || componentSlots[key] === true);
  return result;
}

export function publish(id, definition) {
  const value = state(id);
  if (value.cancelled) return;
  if (!definition || typeof definition !== "object" || definition.id !== id) {
    cancel(id, "source_id_mismatch");
    return;
  }
  value.previous = value.raw;
  if (value.raw && !compatible(value.raw, definition)) value.components.clear();
  value.raw = definition;
  value.definition = bridge(value, definition);
  notify(value);
}

// Only an entry descriptor gets this adapter. Ordinary component modules use Vite's own boundary.
export function acceptDescriptor(runtime, filename, before, after) {
  const id = entryIds.get(filename);
  if (!id || state(id).cancelled) return;
  if (after?.default && after.default !== state(id).raw) publish(id, after.default);
  if (state(id).cancelled) return;
  const stable = before?.default ?? null;
  // The descriptor was reconciled above. React Refresh still decides component and hook compatibility.
  const reason = runtime.validateRefreshBoundaryAndEnqueueUpdate(filename, { ...before, default: stable }, { ...after, default: stable });
  if (reason) {
    const value = state(id);
    value.components.clear();
    value.definition = bridge(value, value.raw);
    notify(value);
    runtime.validateRefreshBoundaryAndEnqueueUpdate(filename, { default: null }, { default: null });
  }
}

const entryIds = new Map();
export function registerEntry(filename, id) { entryIds.set(filename, id); }
export function acceptEntry(filename, id, module) {
  registerEntry(filename, id);
  acceptDescriptor(Refresh, filename, { default: state(id).previous }, module);
}

export function sourceModule(id) {
  const value = state(id);
  return {
    get default() { return value.cancelled ? null : value.definition; },
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
      listener(value.cancelled ? null : value.definition);
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
  for (const [key, sheet] of sheets) if (sheet.owners.includes(id) && !sheet.owners.some((owner) => state(owner).leases > 0)) discardStyle(key);
  notify(value);
  console.warn("plugin-refresh:", id, reason);
}

if (import.meta.hot) {
  import.meta.hot.on(${JSON.stringify(PLUGIN_REFRESH_CANCEL_EVENT)}, ({ ids, reason }) => { for (const id of ids) cancel(id, reason); });
  import.meta.hot.on("vite:ws:disconnect", () => { for (const id of sources.keys()) cancel(id, "disconnected"); });
  // An explicit frontend restart ends old admissions rather than reviving a disconnected lease.
  import.meta.hot.on("vite:beforeFullReload", () => { for (const id of sources.keys()) cancel(id, "restart_required"); });
}
`;
