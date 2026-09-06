import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { EventKindSchema, EventPayloadSchema } from "./events.ts";
import {
  ActionSummarySchema,
  LocalNameSchema,
  PluginEntrySchema,
  PluginIdSchema,
  PluginManifestSchema,
  type ActionDenialRule,
} from "./plugin.ts";
import { PrincipalSchema } from "./principal.ts";
import { ManifoldRefSchema } from "./uri.ts";

/**
 * THE ISOLATION VOCABULARY (ADR 0016): everything that crosses the boundary between the engine
 * and a plugin it does not trust with its own realm.
 *
 * An INSTALLED plugin runs its server half in its own OS process and its web half in its own
 * dedicated Worker (ADR 0016 §1). Both boundaries are message boundaries, so what crosses them
 * is wire, and wire lives here (invariant 2): the frames a supervisor and a child exchange over
 * `Bun.spawn` ipc, the frames a panel host and a Worker exchange over `postMessage`, the closed
 * component vocabulary an isolated web half renders with (§3), the artifact a plugin is
 * installed from (§8 stage 2), and the numbers that bound a runner's patience (§6).
 *
 * Nothing in this file names a plugin, a panel or a host class: the same three-way neutrality
 * the rest of the protocol keeps. First-party plugins never see any of it — the runner is
 * selected by the roster row's `install`, and an in-realm row has none.
 */

// ---------------------------------------------------------------------------- UI vocabulary

/**
 * THE TONES a vocabulary node may ask for. Five words, none of them a colour: an isolated
 * plugin says what a thing MEANS and the host's theme decides how that looks, which is what
 * keeps ink under one owner (S13) while a stranger's panel still gets to say "this is the
 * dangerous button".
 */
export const UI_TONES = ["neutral", "accent", "muted", "danger", "success"] as const;
export const UiToneSchema = z.enum(UI_TONES);
export type UiTone = (typeof UI_TONES)[number];

/**
 * The node kinds of the closed, host-owned component vocabulary (ADR 0016 §3, R2). An isolated
 * web half renders by SENDING A TREE of these — serialized components in, named callbacks
 * out, the MetaMask Snaps shape — and never touches the DOM by any route. The set is closed
 * on purpose: every kind here has exactly one renderer, in the engine, painting one CSS family
 * the engine owns; a kind the host does not know is refused at the schema, never rendered as
 * "unknown".
 */
export const UI_NODE_TYPES = [
  "box",
  "heading",
  "text",
  "code",
  "badge",
  "divider",
  "spinner",
  "button",
  "select",
  "input",
  "toggle",
  "list",
  "empty",
] as const satisfies readonly UiNode["type"][];
export type UiNodeType = (typeof UI_NODE_TYPES)[number];

/**
 * How deep a tree may nest and how many nodes it may carry. A render is one `postMessage`
 * per frame the worker chooses to paint, so the bound is what the main thread can honestly
 * diff and lay out without the worker being able to wedge it — the same reason a section
 * arrangement has `MAX_SECTION_DEPTH`. Refused rather than truncated: a tree the host cannot
 * paint is not one the worker should believe was painted.
 */
export const MAX_UI_DEPTH = 32;
export const MAX_UI_NODES = 2000;

/** The longest run of prose one node carries; a `code` block gets more because it is a dump. */
export const MAX_UI_TEXT_LENGTH = 4096;
export const MAX_UI_CODE_LENGTH = 64 * 1024;
/** Options in one `select`, rows in one `list`: bounded like every contributed list is. */
export const MAX_UI_OPTIONS = 256;
export const MAX_UI_LIST_ITEMS = 500;

/** A named callback: the worker's own word for what a control does, echoed back verbatim. */
const uiEventName = z.string().min(1).max(64);
/** Prose the host paints; never HTML — the renderer sets `textContent`, so this is inert. */
const uiText = z.string().max(MAX_UI_TEXT_LENGTH);

export interface UiSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface UiListItem {
  readonly key: string;
  readonly primary: string;
  readonly secondary?: string | undefined;
  readonly tone?: UiTone | undefined;
  readonly event?: string | undefined;
  readonly payload?: unknown;
}

/**
 * One node of an isolated panel's tree. `button.action` is the FULL action name the button's
 * event ultimately dispatches: the renderer paints it as `data-action`, so a stranger's
 * affordance names the door it opens exactly as a first-party one does (invariant 12, S4).
 */
export type UiNode =
  | {
      readonly type: "box";
      readonly direction?: "row" | "column" | undefined;
      readonly gap?: 0 | 1 | 2 | 3 | undefined;
      readonly grow?: boolean | undefined;
      readonly wrap?: boolean | undefined;
      readonly children: readonly UiNode[];
    }
  | { readonly type: "heading"; readonly text: string; readonly level?: 1 | 2 | 3 | undefined }
  | {
      readonly type: "text";
      readonly text: string;
      readonly tone?: UiTone | undefined;
      readonly mono?: boolean | undefined;
      readonly wrap?: boolean | undefined;
    }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "badge"; readonly text: string; readonly tone?: UiTone | undefined }
  | { readonly type: "divider" }
  | { readonly type: "spinner"; readonly label?: string | undefined }
  | {
      readonly type: "button";
      readonly label: string;
      readonly event: string;
      readonly payload?: unknown;
      readonly tone?: UiTone | undefined;
      readonly disabled?: boolean | undefined;
      readonly action?: string | undefined;
    }
  | {
      readonly type: "select";
      readonly event: string;
      readonly value: string | null;
      readonly options: readonly UiSelectOption[];
      readonly label?: string | undefined;
      readonly disabled?: boolean | undefined;
    }
  | {
      readonly type: "input";
      readonly event: string;
      readonly value: string;
      readonly label?: string | undefined;
      readonly placeholder?: string | undefined;
      readonly mono?: boolean | undefined;
      readonly disabled?: boolean | undefined;
    }
  | {
      readonly type: "toggle";
      readonly event: string;
      readonly value: boolean;
      readonly label: string;
      readonly disabled?: boolean | undefined;
    }
  | { readonly type: "list"; readonly items: readonly UiListItem[] }
  | { readonly type: "empty"; readonly text: string };

/*
  The inventory and the union are pinned to each other the way the instance frames are:
  `satisfies` blocks a name the union lacks, `Exclude` blocks a kind the inventory forgot.
 */
type MissingUiNodeType = Exclude<UiNode["type"], UiNodeType>;
const uiNodeInventoryComplete: MissingUiNodeType extends never ? true : never = true;
void uiNodeInventoryComplete;

/*
  The recursion is declared WITHOUT the size bound, and the bound is applied once at the root
  below: a check attached to the recursive schema itself would re-walk every subtree at every
  level, which is quadratic in depth for no extra refusal.
 */
const uiNode: z.ZodType<UiNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("box"),
      direction: z.enum(["row", "column"]).optional(),
      gap: z.literal([0, 1, 2, 3]).optional(),
      grow: z.boolean().optional(),
      wrap: z.boolean().optional(),
      children: z.array(uiNode).max(MAX_UI_NODES),
    }),
    z.strictObject({
      type: z.literal("heading"),
      text: uiText,
      level: z.literal([1, 2, 3]).optional(),
    }),
    z.strictObject({
      type: z.literal("text"),
      text: uiText,
      tone: UiToneSchema.optional(),
      mono: z.boolean().optional(),
      wrap: z.boolean().optional(),
    }),
    z.strictObject({ type: z.literal("code"), text: z.string().max(MAX_UI_CODE_LENGTH) }),
    z.strictObject({ type: z.literal("badge"), text: uiText, tone: UiToneSchema.optional() }),
    z.strictObject({ type: z.literal("divider") }),
    z.strictObject({ type: z.literal("spinner"), label: uiText.optional() }),
    z.strictObject({
      type: z.literal("button"),
      label: uiText,
      event: uiEventName,
      payload: z.unknown().optional(),
      tone: UiToneSchema.optional(),
      disabled: z.boolean().optional(),
      action: z.string().min(1).max(96).optional(),
    }),
    z.strictObject({
      type: z.literal("select"),
      event: uiEventName,
      value: z.string().max(MAX_UI_TEXT_LENGTH).nullable(),
      options: z
        .array(z.strictObject({ value: z.string().max(MAX_UI_TEXT_LENGTH), label: uiText }))
        .max(MAX_UI_OPTIONS),
      label: uiText.optional(),
      disabled: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("input"),
      event: uiEventName,
      value: z.string().max(MAX_UI_TEXT_LENGTH),
      label: uiText.optional(),
      placeholder: uiText.optional(),
      mono: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("toggle"),
      event: uiEventName,
      value: z.boolean(),
      label: uiText,
      disabled: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("list"),
      items: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(128),
            primary: uiText,
            secondary: uiText.optional(),
            tone: UiToneSchema.optional(),
            event: uiEventName.optional(),
            payload: z.unknown().optional(),
          }),
        )
        .max(MAX_UI_LIST_ITEMS),
    }),
    z.strictObject({ type: z.literal("empty"), text: uiText }),
  ]),
);

/** Walks a parsed tree once; returns the first bound broken, or null when it fits. */
function uiTreeOverflow(root: UiNode): string | null {
  let count = 0;
  const walk = (node: UiNode, depth: number): string | null => {
    if (depth > MAX_UI_DEPTH) return `nests deeper than ${String(MAX_UI_DEPTH)} levels`;
    if (++count > MAX_UI_NODES) return `carries more than ${String(MAX_UI_NODES)} nodes`;
    if (node.type !== "box") return null;
    for (const child of node.children) {
      const overflow = walk(child, depth + 1);
      if (overflow !== null) return overflow;
    }
    return null;
  };
  return walk(root, 1);
}

/**
 * A whole tree, as a `render` frame carries it: every node one of the vocabulary's kinds,
 * every object strict, at most `MAX_UI_DEPTH` deep and `MAX_UI_NODES` large.
 */
export const UiNodeSchema: z.ZodType<UiNode> = uiNode.check((ctx) => {
  const overflow = uiTreeOverflow(ctx.value);
  if (overflow === null) return;
  ctx.issues.push({
    code: "custom",
    input: ctx.value,
    message: `ui tree ${overflow}`,
  });
});

/** The identity of one MOUNTED panel: host-chosen, so two tiles of one panel never collide. */
const instanceId = z.string().min(1).max(128);

/**
 * A named callback firing: which mounted instance, which event the control declared, and the
 * payload the control carried. This is the ONLY direction a user's gesture travels into a
 * worker — as data naming an event, never as a DOM event.
 */
const UiEventFields = {
  instance: instanceId,
  event: uiEventName,
  payload: z.unknown().optional(),
} as const;
export const UiEventSchema = z.strictObject(UiEventFields);
export type UiEvent = z.infer<typeof UiEventSchema>;

// ---------------------------------------------------------------------------- runner policy

/**
 * How many crashes a supervisor tolerates before it stops respawning and says so on the
 * roster (`isolate_crashed`, ADR 0016 §6): VS Code's policy, as data. Past the budget the
 * plugin's doors answer `unavailable` until an operator toggles it.
 */
export const ISOLATE_CRASH_BUDGET = { count: 3, windowMs: 300_000 } as const;

/**
 * The bound on one dispatch into a child (ADR 0016 §6, MetaMask's `maxRequestTime` as
 * precedent): a hung isolate is a REFUSAL (`unavailable`), never a stuck promise. Lifecycle
 * hooks keep the engine's own 2 s bound (`LIFECYCLE_TIMEOUT_MS`).
 */
export const ISOLATE_DISPATCH_DEADLINE_MS = 10_000;

/**
 * How long a child may sit without a dispatch before the supervisor shuts it down; the next
 * dispatch respawns it. One process and one heap per installed plugin is the real cost of
 * the boundary (ADR 0016 §The performance bill), and it scales with installs rather than
 * traffic, which is why eviction is stage-1 policy rather than a later optimisation.
 */
export const ISOLATE_IDLE_EVICT_MS = 600_000;

/** The largest artifact an install door will read, from a path or over the network. */
export const ISOLATE_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------- server IPC frames

/** Correlates a request with its answer on either ipc direction; sender-chosen, opaque. */
const frameId = z.string().min(1).max(64);

/** Prose about a failure, bounded because the child writes it and the host logs it. */
const errorText = z.string().max(2048);

/**
 * The ctx slices a child may CALL BACK into (ADR 0016 §2), each one an RPC the host serves on
 * the plugin's behalf: storage namespaced by plugin id, the dispatching caller's authority,
 * and the two host services a first-party slice already reaches by method name. Everything
 * else in `ActionCtx` is NOT served in stage 1 — the guest runtime raises
 * `IsolateSliceUnavailable(method)` and maps it to `{ ok: false, rule: "refused" }`, so the
 * absence is a named refusal at the door rather than a hang or a throw.
 */
export const ISOLATE_CTX_METHODS = [
  "storage.get",
  "storage.set",
  "storage.delete",
  "storage.keys",
  "auth.allows",
  "outsideScope",
  "newId",
  "machines.isOnline",
  "placement.place",
  "host.roster",
  "host.enabled",
] as const;
export const IsolateCtxMethodSchema = z.enum(ISOLATE_CTX_METHODS);
export type IsolateCtxMethod = (typeof ISOLATE_CTX_METHODS)[number];

/** The three lifecycle hooks a server half may declare; `purge` never crosses (it is the host's). */
export const ISOLATE_HOOKS = ["onEnable", "onDisable", "onAssemblyChanged"] as const;
export const IsolateHookSchema = z.enum(ISOLATE_HOOKS);
export type IsolateHook = (typeof ISOLATE_HOOKS)[number];

/**
 * The two rungs a CHILD may answer: it parses arguments against the action's own zod input
 * (the schema lives where the code lives), and its handler may refuse on domain grounds. Every
 * other rung is the host's — a child cannot say `forbidden` about a caller it never graded.
 */
export const ISOLATE_GUEST_DENIAL_RULES = [
  "invalid_args",
  "refused",
] as const satisfies readonly ActionDenialRule[];
export type IsolateGuestDenialRule = (typeof ISOLATE_GUEST_DENIAL_RULES)[number];

/**
 * What changed in one roster commit, as a child's `onAssemblyChanged` is told. The wire twin
 * of `@manifold/plugin`'s `AssemblyDelta`: both lists in composition order.
 */
export const AssemblyDeltaSchema = z.strictObject({
  enabled: PluginIdSchema.array(),
  disabled: PluginIdSchema.array(),
});
export type AssemblyDelta = z.infer<typeof AssemblyDeltaSchema>;

/**
 * The CALLER, as one dispatch carries it into the child: who asked, what they hold, and the
 * clock — the pieces of `ActionCtx` that are plain data. `auth.allows` is not among them
 * because it consults grants the child never sees; it is served as a call back.
 */
export const IsolateDispatchCtxSchema = z.strictObject({
  traceId: z.number().int().positive(),
  principal: PrincipalSchema,
  caps: CapSchema.array(),
  isRoot: z.boolean(),
  containerScope: z.string().min(1).nullable(),
  now: z.number().int().min(0),
});
export type IsolateDispatchCtx = z.infer<typeof IsolateDispatchCtxSchema>;

/**
 * An answer to a `call`, in either direction on either boundary — one shape, because a
 * worker asking the page for `machines()` and a child asking the server for `storage.get`
 * are the same conversation: an id, and a result or an error sentence.
 */
export const IsolateReplyFrameSchema = z.discriminatedUnion("ok", [
  z.strictObject({ t: z.literal("reply"), id: frameId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ t: z.literal("reply"), id: frameId, ok: z.literal(false), error: errorText }),
]);
export type IsolateReplyFrame = z.infer<typeof IsolateReplyFrameSchema>;

/** At most this many positional arguments ride one `call`; every served method takes fewer. */
const callArgs = z.array(z.unknown()).max(8);

/**
 * HOST → CHILD over `Bun.spawn` ipc (`serialization: "json"`). `load` is the first frame and
 * names the extracted bundle directory the child already runs from; `dispatch` is one action
 * with the caller's authority captured per id, so a `call` the child makes while handling it
 * is graded as THAT caller; `hook` is a lifecycle fan-out; `reply` answers a child's `call`;
 * `shutdown` asks for an orderly exit, and is also what idle eviction sends.
 */
export const IsolateHostFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("load"),
    pluginId: PluginIdSchema,
    manifest: PluginManifestSchema,
    dir: z.string().min(1).max(4096),
  }),
  z.strictObject({
    t: z.literal("dispatch"),
    id: frameId,
    /** The LOCAL action name: the child knows its own plugin id from `load`. */
    action: LocalNameSchema,
    args: z.unknown(),
    ctx: IsolateDispatchCtxSchema,
  }),
  z.strictObject({
    t: z.literal("hook"),
    id: frameId,
    hook: IsolateHookSchema,
    delta: AssemblyDeltaSchema.optional(),
  }),
  IsolateReplyFrameSchema,
  z.strictObject({ t: z.literal("shutdown") }),
]);
export type IsolateHostFrame = z.infer<typeof IsolateHostFrameSchema>;

/** The largest action list a child may announce — the roster publishes every one of them. */
export const MAX_ISOLATE_ACTIONS = 128;
/** Emissions one dispatch may stage; in-realm handlers have no bound because they are trusted. */
export const MAX_ISOLATE_EMITS = 256;

/**
 * CHILD → HOST. `loaded` answers `load` with the actions the child serves — `input` and
 * `result` as JSON Schema (`z.toJSONSchema` of the child's own zod), which is what the roster
 * publishes for them — and which hooks it declared, so the host fans out only what exists.
 * `dispatched` carries the handler's outcome AND the emissions it staged: the host re-stages
 * them through its own `ctx.emit` so the ledger settles before any subscriber hears (A6).
 * `call` is the child reaching a served ctx slice.
 */
export const IsolateChildFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("loaded"),
    actions: ActionSummarySchema.array().max(MAX_ISOLATE_ACTIONS),
    hooks: z.strictObject({
      onEnable: z.boolean(),
      onDisable: z.boolean(),
      onAssemblyChanged: z.boolean(),
    }),
  }),
  z.strictObject({ t: z.literal("load_failed"), error: errorText }),
  z.strictObject({
    t: z.literal("dispatched"),
    id: frameId,
    outcome: z.discriminatedUnion("ok", [
      z.strictObject({
        ok: z.literal(true),
        result: z.unknown(),
        emits: z
          .array(
            z.strictObject({
              ref: ManifoldRefSchema,
              kind: EventKindSchema,
              payload: EventPayloadSchema,
            }),
          )
          .max(MAX_ISOLATE_EMITS),
      }),
      z.strictObject({
        ok: z.literal(false),
        rule: z.enum(ISOLATE_GUEST_DENIAL_RULES),
        message: errorText,
      }),
    ]),
  }),
  z.strictObject({
    t: z.literal("hooked"),
    id: frameId,
    ok: z.boolean(),
    error: errorText.optional(),
  }),
  z.strictObject({
    t: z.literal("call"),
    id: frameId,
    method: IsolateCtxMethodSchema,
    args: callArgs,
  }),
]);
export type IsolateChildFrame = z.infer<typeof IsolateChildFrameSchema>;

// ---------------------------------------------------------------------------- web worker frames

/**
 * The host services a Worker may call back into, by name — the same semantics as
 * `SessionHandle`'s methods of those names (the terminal three arrive with #196). The page
 * serves each from the panel's REAL `HostServices`, so the worker never holds the token
 * (ADR 0016 §3): it calls the door through the host, which attaches the caller's authority.
 */
export const WEB_HOST_METHODS = [
  "action",
  "place",
  "selfCaps",
  "machines",
  "resolve",
  "navigate",
  "openTerminal",
  "sendTerminalInput",
  "terminalsByContainer",
] as const;
export const WebHostMethodSchema = z.enum(WEB_HOST_METHODS);
export type WebHostMethod = (typeof WEB_HOST_METHODS)[number];

/**
 * PAGE → WORKER over `postMessage`. `init` is the first frame: who the viewer is and what
 * they hold, as data, so the guest can shape its UI without asking; `mount`/`unmount` bracket
 * one panel instance's life in a tile; `event` is a named callback firing; `reply` answers
 * the worker's `call`.
 */
export const WebIsolateHostFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("init"),
    pluginId: PluginIdSchema,
    principal: PrincipalSchema,
    caps: CapSchema.array(),
    containerId: z.string().min(1).nullable(),
  }),
  z.strictObject({ t: z.literal("mount"), instance: instanceId, panel: LocalNameSchema }),
  z.strictObject({ t: z.literal("unmount"), instance: instanceId }),
  z.strictObject({ t: z.literal("event"), ...UiEventFields }),
  IsolateReplyFrameSchema,
]);
export type WebIsolateHostFrame = z.infer<typeof WebIsolateHostFrameSchema>;

/** The panel ids a worker serves; bounded as the manifest bounds `contributes.panels`. */
export const MAX_ISOLATE_PANELS = 8;

/**
 * WORKER → PAGE. `ready` names the panels the guest serves, so a manifest panel with no
 * program is a named absence rather than a blank tile; `render` is the whole tree for one
 * instance, replaced wholesale — the host diffs, the worker never patches; `call` reaches a
 * host method; `fault` is the worker's own report that a program threw, scoped to an instance
 * when one was involved. A fault is per-session and touches no roster row (§6: the roster
 * says what the SERVER knows, and a browser's failure is not that).
 */
export const WebIsolateWorkerFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("ready"),
    panels: LocalNameSchema.array().max(MAX_ISOLATE_PANELS),
  }),
  z.strictObject({ t: z.literal("render"), instance: instanceId, tree: UiNodeSchema }),
  z.strictObject({
    t: z.literal("call"),
    id: frameId,
    method: WebHostMethodSchema,
    args: callArgs,
  }),
  z.strictObject({ t: z.literal("fault"), instance: instanceId.optional(), error: errorText }),
]);
export type WebIsolateWorkerFrame = z.infer<typeof WebIsolateWorkerFrameSchema>;

// ---------------------------------------------------------------------------- the artifact

/**
 * The artifact format an install door reads: ONE JSON document, `<id>.manifold-plugin.json`.
 * JSON rather than a tarball because the protocol package's whole runtime dependency budget is
 * zod (invariant 8) and a hand-rolled tar reader is a worse artifact than base64. `sha256` on
 * the roster row is over the file's exact BYTES, never over this parsed form, so re-hashing at
 * boot compares what was installed with what is on disk (ADR 0016 §8 stage 3, R8: fail-closed).
 * The literal is the whole versioning story: a reader that meets a format it does not know
 * refuses `artifact_invalid` and says which.
 */
export const PLUGIN_BUNDLE_FORMAT = 1;

/**
 * The file the server guest lives in when `entry.server` is true. A NAME rather than a field
 * because the bundle is self-contained — the kit's `pack` inlines the guest runtime into it —
 * and `Bun.spawn(["bun", "--smol", "<dir>/server.js"])` is the whole loader.
 */
export const PLUGIN_BUNDLE_SERVER_FILE = "server.js";

/**
 * The file the web half's skin lives in when `entry.styles` is true (ADR 0025 §7, #258): one
 * fixed name for the same reason as the server's — the loader fetches it by name at
 * `GET /api/plugins/:id/styles.css`, and the hub reads it by name to admit it. An OPTIONAL
 * member of an already-open `files` record, so a bundle written before it existed parses
 * unchanged and the format literal did not move.
 */
export const PLUGIN_BUNDLE_STYLES_FILE = "styles.css";

/**
 * A member's name inside the bundle: FLAT, one path segment, no leading dot. The files are
 * extracted beside the artifact into `<sha256>/`, so a name that could climb (`../`), nest, or
 * hide (`.env`) is refused at the schema rather than trusted to the extractor (invariant 6).
 */
export const PLUGIN_BUNDLE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PluginBundleFileSchema = z.string().regex(PLUGIN_BUNDLE_FILE_PATTERN);
export const MAX_PLUGIN_BUNDLE_FILES = 64;

/**
 * The artifact, parsed. `manifest.entry` is REQUIRED here (the manifest schema leaves it
 * optional because an in-realm manifest has no entry to name) and must name at least one
 * half; every half it names must be a member of `files`, so an installed plugin never
 * discovers at enable time that its own bundle is missing its code — and a declared sheet
 * must be there too, beside a web half to dress. Members are base64 of the file's bytes, each
 * bounded by the artifact cap because nothing inside an artifact can be larger than the
 * artifact.
 */
export const PluginBundleSchema = z
  .strictObject({
    format: z.literal(PLUGIN_BUNDLE_FORMAT),
    manifest: PluginManifestSchema.extend({ entry: PluginEntrySchema }),
    /** Shared React and floor-package versions used at build time (ADR 0025). */
    builtAgainst: z.record(z.string(), z.string()).optional(),
    files: z
      .record(PluginBundleFileSchema, z.base64().max(ISOLATE_MAX_ARTIFACT_BYTES))
      .check((ctx) => {
        const count = Object.keys(ctx.value).length;
        if (count <= MAX_PLUGIN_BUNDLE_FILES) return;
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: `bundle carries ${String(count)} files, at most ${String(MAX_PLUGIN_BUNDLE_FILES)} are allowed`,
        });
      }),
  })
  .check((ctx) => {
    const { entry } = ctx.value.manifest;
    const missing = (name: string, half: string): void => {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["manifest", "entry", half],
        message: `entry.${half} names "${name}" but files has no such member`,
      });
    };
    if (entry.server !== true && entry.web === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["manifest", "entry"],
        message: "entry names neither half: a bundle with nothing to run is not a plugin",
      });
      return;
    }
    if (entry.server === true && !Object.hasOwn(ctx.value.files, PLUGIN_BUNDLE_SERVER_FILE)) {
      missing(PLUGIN_BUNDLE_SERVER_FILE, "server");
    }
    if (entry.web !== undefined && !Object.hasOwn(ctx.value.files, entry.web)) {
      missing(entry.web, "web");
    }
    if (entry.styles !== true) return;
    if (entry.web === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["manifest", "entry", "styles"],
        message: "entry.styles names a sheet but no web half wears it",
      });
    } else if (!Object.hasOwn(ctx.value.files, PLUGIN_BUNDLE_STYLES_FILE)) {
      missing(PLUGIN_BUNDLE_STYLES_FILE, "styles");
    }
  });
export type PluginBundle = z.infer<typeof PluginBundleSchema>;

/**
 * The isolation vocabulary, published — beside `pluginVocabulary()` at `GET /api/protocol`.
 * A stranger authoring an out-of-tree plugin learns from one read which component kinds a
 * panel may render and how large a tree may be, which ctx slices and host methods a guest may
 * call, the runner's deadlines, and the artifact shape `pack` must emit (issue #151: "ships
 * the closed component vocabulary as data at `GET /api/protocol`").
 */
export function isolateVocabulary(): Record<string, unknown> {
  return {
    uiTones: UI_TONES,
    uiNodeTypes: UI_NODE_TYPES,
    maxUiDepth: MAX_UI_DEPTH,
    maxUiNodes: MAX_UI_NODES,
    ctxMethods: ISOLATE_CTX_METHODS,
    hostMethods: WEB_HOST_METHODS,
    crashBudget: ISOLATE_CRASH_BUDGET,
    dispatchDeadlineMs: ISOLATE_DISPATCH_DEADLINE_MS,
    idleEvictMs: ISOLATE_IDLE_EVICT_MS,
    maxArtifactBytes: ISOLATE_MAX_ARTIFACT_BYTES,
    bundleFormat: PLUGIN_BUNDLE_FORMAT,
    bundleServerFile: PLUGIN_BUNDLE_SERVER_FILE,
    uiEvent: z.toJSONSchema(UiEventSchema),
    bundle: z.toJSONSchema(PluginBundleSchema),
  };
}
