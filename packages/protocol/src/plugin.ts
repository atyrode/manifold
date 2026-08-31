import { z } from "zod";
import { CapSchema } from "./capabilities.ts";

/**
 * The plugin vocabulary: what a plugin IS on the wire, and what invoking one of its
 * actions can answer. Everything here is inert DATA — a manifest declares, it never
 * executes — so the same shapes describe an in-process core plugin today and an isolated
 * third-party runner later without a second format.
 *
 * A plugin id is dotted and namespaced (`core.terminals`): the leading segment is the
 * authority publishing it, so two authors can both ship a `terminals` plugin without a
 * collision, and a collision inside one namespace is a named refusal rather than
 * shadowing (AXIOMS.md D5).
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const PluginIdSchema = z.string().regex(PLUGIN_ID_PATTERN).max(64);
export type PluginId = z.infer<typeof PluginIdSchema>;

/**
 * A contribution's name INSIDE its plugin. Every published name is the pair — an action is
 * `${manifest.id}.${local}` on the wire — so a plugin can never name anything outside its
 * own namespace and a full name always says who owns it.
 *
 * Exported because the composition engine validates every action's local name against this
 * exact rule before it builds a full name: one door per concept, so a local name is legal
 * here and there or nowhere.
 *
 * Interior capitals are allowed because the ratified vocabulary uses them where the name is
 * a verb phrase (`core.plugins.setEnabled`); a name still starts lowercase and carries no
 * dot, so the segment boundary in a full name stays unambiguous.
 */
export const LOCAL_NAME_PATTERN = /^[a-z][a-zA-Z0-9-]*$/;
export const LocalNameSchema = z.string().regex(LOCAL_NAME_PATTERN).max(32);
export type LocalName = z.infer<typeof LocalNameSchema>;

const TitleSchema = z.string().min(1).max(64);

/**
 * What a plugin declares it adds to the composition. Each list is bounded, because a
 * manifest is read on every roster fan-out and a plugin contributing hundreds of anything
 * is a plugin that should be several.
 *
 * `panels` are tile-surface leaves (the workspace shell is itself a composition of them),
 * `sections` are sidebar sections ordered by their declared `order`, `elements` are canvas
 * element renderers keyed by wire type, `tools` are toolbar tools.
 */
const ContributesSchema = z.strictObject({
  panels: z.array(z.strictObject({ id: LocalNameSchema, title: TitleSchema })).max(8).default([]),
  sections: z
    .array(z.strictObject({ id: LocalNameSchema, title: TitleSchema, order: z.number().int() }))
    .max(8)
    .default([]),
  elements: z
    .array(z.strictObject({ type: z.string().min(1).max(32), title: TitleSchema }))
    .max(8)
    .default([]),
  tools: z.array(z.strictObject({ id: LocalNameSchema, title: TitleSchema })).max(8).default([]),
  /** reserved: event plane, wave 2 (ADR 0012); no wave-1 consumer */
  events: z.array(z.strictObject({ id: LocalNameSchema, title: TitleSchema })).max(16).default([]),
});

export const PluginManifestSchema = z.strictObject({
  id: PluginIdSchema,
  version: z.string().min(1).max(32),
  title: TitleSchema,
  description: z.string().max(500),
  /**
   * The ceiling on this plugin's authority: every action it declares must ask for a subset
   * of these, and a dispatch intersects them with the CALLER's caps. Declaring caps here is
   * what makes a manifest auditable without reading the plugin's code.
   */
  capabilities: CapSchema.array().max(16),
  /**
   * An essential plugin cannot be disabled: the workspace has no way to render itself
   * without it, so the refusal is kinder than the blank screen. `core.shell` is the only
   * essential plugin this wave.
   */
  essential: z.boolean().optional(),
  contributes: ContributesSchema,
  /** reserved, dynamic wave */
  entry: z.strictObject({ web: z.string().optional(), server: z.boolean().optional() }).optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * One action, published. `input` and `result` are JSON Schemas rather than zod shapes,
 * because the audience is a stranger's agent reading `GET /api/protocol` — the door's own
 * validators are generated from the same definitions, so the published schema is the
 * schema the dispatcher enforces, never a hand-written description of it.
 */
export const ActionSummarySchema = z.strictObject({
  /** Fully qualified: `${pluginId}.${localName}`. */
  name: z.string(),
  title: z.string(),
  caps: CapSchema.array(),
  /**
   * A cleanup action stays dispatchable while its plugin is disabled (D12: creation and
   * administration die on disable, removal survives — nobody is locked out of deleting).
   * Published so a client can tell which affordances outlive a toggle.
   */
  cleanup: z.boolean().optional(),
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});
export type ActionSummary = z.infer<typeof ActionSummarySchema>;

/**
 * A plugin as the roster describes it. `source` says where the code came from — only
 * `builtin` exists this wave, and the field is here so a distributed plugin does not need
 * a new roster shape to be told apart from one compiled in.
 */
export const PluginRosterEntrySchema = z.strictObject({
  manifest: PluginManifestSchema,
  enabled: z.boolean(),
  source: z.literal("builtin"),
  actions: ActionSummarySchema.array(),
});
export type PluginRosterEntry = z.infer<typeof PluginRosterEntrySchema>;

/**
 * The whole composition, as every principal sees it: server-owned, served at
 * `GET /api/plugins`, and pushed on the connection-level `plugins` session frame whenever
 * it changes. Registration is shared state, never a client's private guess.
 */
export const PluginRosterSchema = PluginRosterEntrySchema.array();
export type PluginRoster = z.infer<typeof PluginRosterSchema>;

/**
 * Why a dispatch was refused. The ladder is MONOTONIC and evaluated in this order, so a
 * caller learns the FIRST thing wrong rather than a summary: the action must exist, its
 * plugin must be enabled, the caller must be allowed to reach the door at all, the caller
 * must hold every declared cap, the arguments must parse, and only then may the handler
 * itself refuse on state it alone can see (`refused`).
 */
export const ACTION_DENIAL_RULES = [
  "unknown_action",
  "plugin_disabled",
  "forbidden",
  "invalid_args",
  "refused",
] as const;
export const ActionDenialSchema = z.strictObject({
  rule: z.enum(ACTION_DENIAL_RULES),
  message: z.string(),
});
export type ActionDenial = z.infer<typeof ActionDenialSchema>;
export type ActionDenialRule = (typeof ACTION_DENIAL_RULES)[number];

/**
 * What the action door answers. A denial is a 200 carrying `ok: false` — the same shape
 * `POST /api/place` uses for a refused placement, because a refusal is an ANSWER about
 * authority or state, not a transport failure.
 */
export const ActionOutcomeSchema = z.union([
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ok: z.literal(false), denial: ActionDenialSchema }),
]);
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
