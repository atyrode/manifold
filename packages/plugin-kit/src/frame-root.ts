import {
  MAX_UI_DEPTH,
  MAX_UI_NODES,
  MAX_UI_TEXT_LENGTH,
  UI_NODE_TYPES,
  UiNodeSchema,
  type UiNode,
  type UiNodeType,
} from "@manifold/protocol";
import { FRAME_ELEMENT_PREFIX } from "@manifold/ui/frames";
import { createContext, type ReactNode } from "react";
import createReconciler, { type HostConfig, type ReactContext } from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";

/**
 * THE FRAME RENDERER (ADR 0053): real React reconciling into the closed component vocabulary.
 *
 * React owns everything a component means — hooks, context, keyed identity, scheduling, error
 * boundaries and effect lifetime. This host adapter owns only the leaves: each `manifold:*`
 * intrinsic that `@manifold/ui/frames` emits becomes one host node with a stable identity, and
 * every commit projects the committed nodes into ONE bounded `UiNode` tree. Callbacks never
 * cross the boundary: a control is painted with an event name derived from its own never-reused
 * identity, and an arriving event resolves against the controls of the latest commit only.
 * Anything outside the vocabulary — raw text, a DOM tag, `className`, `style`, a ref, an unknown
 * prop — is refused by name, never dropped.
 */

/** Where a root's committed trees and failures go. */
export interface UiRootCallbacks {
  /** A validated committed tree that differs from the last one delivered. */
  commit(tree: UiNode): void;
  /** The root can no longer render: it has stopped emitting and answering events. */
  fault(error: Error): void;
  /** Non-fatal: caught by an error boundary, recovered by React, or thrown by a handler. */
  report(error: unknown): void;
}

export interface UiRoot {
  render(element: ReactNode): void;
  /**
   * Delivers one named control event to the callback its CURRENT committed control holds.
   * Answers null when delivered, or the sentence saying why the event was refused.
   */
  event(name: string, payload: unknown): string | null;
  /** Unmounts synchronously, running every effect cleanup before it returns. */
  unmount(): void;
}

// ---------------------------------------------------------------------------- vocabulary

const META_PROPS: readonly string[] = ["title", "ariaLabel", "testId", "role"];

/** Each kind's data props: exactly its `UiNode` fields other than `type` and the event words. */
const DATA_PROPS: Readonly<Record<UiNodeType, readonly string[]>> = {
  // `gap` is the protocol's closed step or `adaptive` default; explicit spacing rides `gapRem`.
  box: ["direction", "gap", "gapRem", "align", "justify", "grow", "wrap"],
  heading: ["text", "level"],
  text: ["text", "tone", "mono", "wrap", "strong", "grow"],
  code: ["text"],
  badge: ["text", "tone"],
  icon: ["icon"],
  divider: [],
  spinner: ["label"],
  button: ["label", "tone", "disabled", "action", "icon", "iconOnly"],
  select: ["value", "options", "label", "disabled"],
  input: ["value", "label", "placeholder", "mono", "disabled"],
  toggle: ["value", "label", "disabled"],
  list: ["items"],
  empty: ["text"],
};

/** The callbacks each control kind carries in place of the wire's event words. */
const CALLBACK_PROPS: Readonly<Partial<Record<UiNodeType, readonly string[]>>> = {
  button: ["onClick", "onBlur"],
  select: ["onChange", "onBlur"],
  input: ["onChange", "onBlur"],
  toggle: ["onChange", "onBlur"],
};

const LIST_ITEM_DATA: readonly string[] = ["key", "primary", "secondary", "tone"];

type Props = Readonly<Record<string, unknown>>;
type ListItem = Readonly<Record<string, unknown>>;

interface FrameContainer {
  readonly children: FrameNode[];
  /** A commit mutated the tree since the last projection. */
  dirty: boolean;
  /** Node and row identities; never reused within this root. */
  nextId: number;
  /** Called at the end of each commit; schedules one projection once React's commit returns. */
  flush(): void;
}

/** One leaf, committed or pending. */
interface FrameNode {
  readonly id: number;
  readonly kind: UiNodeType;
  readonly tag: string;
  readonly container: FrameContainer;
  props: Props;
  readonly children: FrameNode[];
  hidden: boolean;
  /** A list's row events, kept while the row's key stays committed. */
  rows: ReadonlyMap<string, string>;
}

type Slot = "click" | "blur" | "change" | { readonly row: string };

interface Registration {
  readonly node: FrameNode;
  readonly slot: Slot;
}

interface Projected {
  readonly tree: unknown;
  readonly registry: ReadonlyMap<string, Registration>;
}

function typeName(value: unknown): string {
  if (typeof value === "function") return "a function";
  return value === null ? "null" : typeof value;
}

function kindOf(type: string): UiNodeType {
  const kind = type.startsWith(FRAME_ELEMENT_PREFIX) ? type.slice(FRAME_ELEMENT_PREFIX.length) : "";
  if (!(UI_NODE_TYPES as readonly string[]).includes(kind)) {
    throw new Error(
      `<${type}> is not a frame component: a portable contribution renders only the ${FRAME_ELEMENT_PREFIX}* components @manifold/ui emits`,
    );
  }
  return kind as UiNodeType;
}

/** Refuses anything a kind does not declare; values are checked again by the tree's schema. */
function acceptProps(kind: UiNodeType, tag: string, props: Props): Props {
  const data = DATA_PROPS[kind];
  const callbacks = CALLBACK_PROPS[kind] ?? [];
  for (const [name, value] of Object.entries(props)) {
    if (name === "children") {
      if (kind !== "box" && value !== undefined && value !== null && value !== false) {
        throw new Error(`<${tag}> takes no children; its text is a prop`);
      }
      continue;
    }
    if (value === undefined) continue;
    if (callbacks.includes(name)) {
      if (typeof value !== "function") {
        throw new Error(`<${tag}> ${name} must be a function, not ${typeName(value)}`);
      }
    } else if (data.includes(name) || META_PROPS.includes(name)) {
      if (typeof value === "function") throw new Error(`<${tag}> ${name} cannot be a function`);
    } else {
      throw new Error(`<${tag}> does not accept "${name}" in a frame`);
    }
  }
  if (kind === "list" && props["items"] !== undefined) acceptItems(tag, props["items"]);
  return props;
}

function acceptItems(tag: string, items: unknown): void {
  if (!Array.isArray(items)) throw new Error(`<${tag}> items must be an array`);
  const keys = new Set<string>();
  for (const item of items as readonly unknown[]) {
    if (typeof item !== "object" || item === null) {
      throw new Error(`<${tag}> items must be objects, not ${typeName(item)}`);
    }
    for (const [name, value] of Object.entries(item)) {
      if (value === undefined) continue;
      if (name === "onClick") {
        if (typeof value !== "function") {
          throw new Error(`<${tag}> item onClick must be a function, not ${typeName(value)}`);
        }
      } else if (!LIST_ITEM_DATA.includes(name)) {
        throw new Error(`<${tag}> item does not accept "${name}" in a frame`);
      } else if (typeof value === "function") {
        throw new Error(`<${tag}> item ${name} cannot be a function`);
      }
    }
    const key: unknown = Reflect.get(item, "key");
    if (typeof key !== "string") throw new Error(`<${tag}> item key must be a string`);
    if (keys.has(key)) throw new Error(`<${tag}> item key "${key}" is not unique`);
    keys.add(key);
  }
}

// ---------------------------------------------------------------------------- the host config

type TimerHandle = ReturnType<typeof setTimeout>;

/** The 0.33 members its type package predates; each is answered honestly below. */
interface FrameHostConfig extends HostConfig<
  string,
  Props,
  FrameContainer,
  FrameNode,
  never,
  never,
  never,
  never,
  never,
  object,
  never,
  TimerHandle,
  -1,
  null
> {
  readonly rendererPackageName: string;
  readonly rendererVersion: string;
  readonly extraDevToolsConfig: null;
  maySuspendCommitOnUpdate(type: string, oldProps: Props, newProps: Props): boolean;
  maySuspendCommitInSyncRender(type: string, props: Props): boolean;
  getSuspendedCommitReason(): null;
  bindToConsole(method: "error" | "warn" | "info" | "log", args: unknown[]): () => void;
}

const ROOT_CONTEXT: object = Object.freeze({});
/** React's current update priority for this renderer: set around discrete events. */
let updatePriority: number = NoEventPriority;

function refuseText(): never {
  throw new Error(
    "raw text cannot render in a frame: pass it to a text-bearing component (Text, Heading, Badge, Code, Empty, Button)",
  );
}

function place(list: FrameNode[], child: FrameNode, before?: FrameNode): void {
  const existing = list.indexOf(child);
  if (existing !== -1) list.splice(existing, 1);
  const at = before === undefined ? -1 : list.indexOf(before);
  if (at === -1) list.push(child);
  else list.splice(at, 0, child);
  child.container.dirty = true;
}

function childrenOf(parent: FrameNode): FrameNode[] {
  if (parent.kind !== "box") throw new Error(`<${parent.tag}> takes no children`);
  return parent.children;
}

function remove(list: FrameNode[], child: FrameNode): void {
  const at = list.indexOf(child);
  if (at !== -1) list.splice(at, 1);
  child.container.dirty = true;
}

const hostConfig: FrameHostConfig = {
  rendererPackageName: "@manifold/plugin-kit",
  rendererVersion: "0.33.0",
  extraDevToolsConfig: null,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  // This renderer owns its dedicated Worker's primary React context slot.
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  scheduleMicrotask: (fn) => queueMicrotask(fn),
  scheduleTimeout: (fn, delay) => setTimeout(fn, delay),
  cancelTimeout: (id) => clearTimeout(id),
  noTimeout: -1,

  createInstance(type, props, container) {
    const kind = kindOf(type);
    return {
      id: ++container.nextId,
      kind,
      tag: type,
      container,
      props: acceptProps(kind, type, props),
      children: [],
      hidden: false,
      rows: new Map(),
    };
  },
  createTextInstance: refuseText,
  appendInitialChild: (parent, child) => place(childrenOf(parent), child),
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => ROOT_CONTEXT,
  getChildHostContext: (parent) => parent,
  getPublicInstance(): never {
    throw new Error("refs are not available in a frame: a frame component has no DOM node");
  },
  prepareForCommit: () => null,
  resetAfterCommit: (container) => container.flush(),
  preparePortalMount: () => {},

  appendChild: (parent, child) => place(childrenOf(parent), child),
  appendChildToContainer: (container, child) => place(container.children, child),
  insertBefore: (parent, child, before) => place(childrenOf(parent), child, before),
  insertInContainerBefore: (container, child, before) => place(container.children, child, before),
  removeChild: (parent, child) => remove(parent.children, child),
  removeChildFromContainer: (container, child) => remove(container.children, child),
  commitUpdate(node, _type, _previous, next) {
    node.props = acceptProps(node.kind, node.tag, next);
    node.container.dirty = true;
  },
  commitTextUpdate: refuseText,
  resetTextContent: () => {},
  hideInstance(node) {
    node.hidden = true;
    node.container.dirty = true;
  },
  unhideInstance(node) {
    node.hidden = false;
    node.container.dirty = true;
  },
  hideTextInstance: refuseText,
  unhideTextInstance: refuseText,
  clearContainer(container) {
    container.children.length = 0;
    container.dirty = true;
  },
  detachDeletedInstance(node) {
    // A deleted control keeps no closure alive; its events already left the registry.
    node.props = {};
    node.children.length = 0;
  },

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,

  NotPendingTransition: null,
  HostTransitionContext: createContext<null>(null) as unknown as ReactContext<null>,
  setCurrentUpdatePriority(priority) {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () =>
    updatePriority === NoEventPriority ? DefaultEventPriority : updatePriority,
  resetFormInstance: () => {},
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  // Nothing in the vocabulary loads before it can commit.
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  bindToConsole: (method, args) => console[method].bind(console, ...args),
};

const reconciler = createReconciler(hostConfig);

// ---------------------------------------------------------------------------- projection

function copyFields(from: Props, names: readonly string[], into: Record<string, unknown>): void {
  for (const name of names) {
    const value = from[name];
    if (value !== undefined) into[name] = value;
  }
}

/** One commit's tree and the registry of exactly the controls it paints. */
class Projection {
  readonly registry = new Map<string, Registration>();
  private count: number;

  constructor(
    private readonly container: FrameContainer,
    synthesizedRoot: boolean,
  ) {
    this.count = synthesizedRoot ? 1 : 0;
  }

  node(node: FrameNode, depth: number): unknown {
    if (depth > MAX_UI_DEPTH) {
      throw new Error(`ui tree nests deeper than ${String(MAX_UI_DEPTH)} levels`);
    }
    if (++this.count > MAX_UI_NODES) {
      throw new Error(`ui tree carries more than ${String(MAX_UI_NODES)} nodes`);
    }
    const out: Record<string, unknown> = { type: node.kind, key: `n${String(node.id)}` };
    copyFields(node.props, META_PROPS, out);
    copyFields(node.props, DATA_PROPS[node.kind], out);
    if (CALLBACK_PROPS[node.kind] !== undefined) {
      out["event"] = this.register(node, node.kind === "button" ? "click" : "change");
      if (node.props["onBlur"] !== undefined) out["blurEvent"] = this.register(node, "blur");
    }
    if (node.kind === "box") {
      out["children"] = node.children
        .filter((child) => !child.hidden)
        .map((child) => this.node(child, depth + 1));
    }
    if (node.kind === "list") out["items"] = this.rows(node);
    return out;
  }

  private register(node: FrameNode, slot: "click" | "blur" | "change"): string {
    const name = `n${String(node.id)}.${slot}`;
    this.registry.set(name, { node, slot });
    return name;
  }

  /** A row keeps its event while its key stays committed; a returning key gets a fresh one. */
  private rows(node: FrameNode): Record<string, unknown>[] {
    const items = (node.props["items"] ?? []) as readonly ListItem[];
    const rows = new Map<string, string>();
    const out = items.map((item) => {
      const row: Record<string, unknown> = {};
      copyFields(item, LIST_ITEM_DATA, row);
      if (item["onClick"] !== undefined) {
        const key = item["key"] as string;
        const event =
          node.rows.get(key) ?? `n${String(node.id)}.row${String(++this.container.nextId)}`;
        rows.set(key, event);
        this.registry.set(event, { node, slot: { row: key } });
        row["event"] = event;
      }
      return row;
    });
    node.rows = rows;
    return out;
  }
}

function project(container: FrameContainer): Projected {
  const visible = container.children.filter((child) => !child.hidden);
  const [only] = visible;
  // One root node is the tree; nothing, or siblings, sit in the column a contribution fills.
  if (visible.length === 1 && only !== undefined) {
    const projection = new Projection(container, false);
    return { tree: projection.node(only, 1), registry: projection.registry };
  }
  const projection = new Projection(container, true);
  const children = visible.map((child) => projection.node(child, 2));
  return { tree: { type: "box", key: "root", children }, registry: projection.registry };
}

// ---------------------------------------------------------------------------- the root

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The value a slot's callback receives, or the refusal of a payload of the wrong shape. */
function checkedValue(
  node: FrameNode,
  slot: Slot,
  payload: unknown,
): { readonly value: unknown } | string {
  if (slot !== "change") {
    return payload === undefined ? { value: undefined } : "this control's event carries no payload";
  }
  if (node.kind === "toggle") {
    return typeof payload === "boolean" ? { value: payload } : "toggle changes must be booleans";
  }
  if (typeof payload !== "string" || payload.length > MAX_UI_TEXT_LENGTH) {
    return `${node.kind} changes must be strings of at most ${String(MAX_UI_TEXT_LENGTH)} characters`;
  }
  if (node.kind === "select") {
    const options = (node.props["options"] ?? []) as readonly ListItem[];
    if (!options.some((option) => option["value"] === payload)) {
      return "the chosen value is not one of the select's committed options";
    }
  }
  return { value: payload };
}

function handlerFor(node: FrameNode, slot: Slot): unknown {
  if (typeof slot === "object") {
    const items = (node.props["items"] ?? []) as readonly ListItem[];
    return items.find((item) => item["key"] === slot.row)?.["onClick"];
  }
  return node.props[slot === "click" ? "onClick" : slot === "blur" ? "onBlur" : "onChange"];
}

/**
 * One retained React root over one frame container. `render` schedules like any concurrent
 * root; `commit` fires once React has finished a commit whose validated projection changed —
 * after its layout phase, so a commit React makes while failing (the unmount of an uncaught
 * error) is never published as if it were the author's tree; an event runs as a discrete
 * update, so the state it sets commits before the next task.
 */
export function createUiRoot(callbacks: UiRootCallbacks): UiRoot {
  let registry: ReadonlyMap<string, Registration> = new Map();
  let delivered: string | null = null;
  let scheduled = false;
  let stopped = false;
  let unmounted = false;

  const fail = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    registry = new Map();
    callbacks.fault(asError(error));
  };

  /** Projects whatever is committed now; commits within one turn coalesce into one tree. */
  const publish = (): void => {
    scheduled = false;
    if (stopped || !container.dirty) return;
    container.dirty = false;
    let projected: Projected;
    try {
      projected = project(container);
    } catch (error) {
      fail(error);
      return;
    }
    const parsed = UiNodeSchema.safeParse(projected.tree);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("; ");
      fail(new Error(`rendered a tree outside the vocabulary: ${issues}`));
      return;
    }
    registry = projected.registry;
    const text = JSON.stringify(parsed.data);
    if (text === delivered) return;
    delivered = text;
    try {
      callbacks.commit(parsed.data);
    } catch (error) {
      fail(error);
    }
  };

  const container: FrameContainer = {
    children: [],
    dirty: false,
    nextId: 0,
    flush() {
      if (stopped || !container.dirty || scheduled) return;
      scheduled = true;
      queueMicrotask(publish);
    },
  };

  const root: unknown = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    (error) => fail(error),
    (error) => callbacks.report(error),
    (error) => callbacks.report(error),
    () => {},
  );

  return {
    render(element) {
      if (stopped) return;
      reconciler.updateContainer(element, root, null, null);
    },
    event(name, payload) {
      if (stopped) return "the frame is no longer rendering";
      const registration = registry.get(name);
      if (registration === undefined) return "no committed control holds that event";
      const { node, slot } = registration;
      if (slot !== "blur" && node.props["disabled"] === true) return "the control is disabled";
      const checked = checkedValue(node, slot, payload);
      if (typeof checked === "string") return checked;
      const handler = handlerFor(node, slot);
      if (typeof handler !== "function") return null;
      try {
        reconciler.discreteUpdates(
          () => (slot === "change" ? handler(checked.value) : handler()),
          undefined,
          undefined,
          undefined,
          undefined,
        );
      } catch (error) {
        callbacks.report(error);
      }
      return null;
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      stopped = true;
      registry = new Map();
      reconciler.updateContainerSync(null, root, null, null);
      reconciler.flushSyncWork();
      reconciler.flushPassiveEffects();
    },
  };
}
