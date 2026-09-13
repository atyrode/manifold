import { z } from "zod";

/**
 * Capability-scoped authority. Uniform identity (humans and agents are both principals)
 * never implies uniform authority: every token carries an explicit cap set, optionally
 * scoped to a single container.
 *
 * Every name is `<domain-plural>:<verb>`, which is the whole naming law: a reader of a
 * token's cap set can tell what it reaches and what it may do there without a table.
 */
export const CAPS = [
  "*",
  "containers:read",
  "containers:write",
  "scenes:write",
  "terminals:spawn",
  "terminals:write",
  "tokens:mint",
  "machines:mint",
  "machines:run",
  "jobs:read",
  "jobs:input",
  "jobs:cancel",
  "locations:read",
  "locations:write",
  "locations:create",
  "operations:invoke",
  "services:read",
  "services:invoke",
  "services:configure",
  "network:host",
  /** Enable and disable plugins for the whole workspace: assembly administration. */
  "plugins:manage",
] as const;

export const CapSchema = z.enum(CAPS);
export type Cap = z.infer<typeof CapSchema>;

/**
 * THE ENGINE'S HALF IS CLOSED AND A PLUGIN'S IS OPEN (ADR 0035).
 *
 * `CAPS` above is the ENGINE's vocabulary and stays an enum: every name in it is authority
 * over a door the engine itself owns, `GOVERNED_CAPS` below is a subset of it, and the
 * switches that branch on it are exhaustive. A plugin's own authority cannot live in that
 * enum — `atyrode.babel:archive` is not a word the engine knows, and admitting it would mean
 * the closed set grows by every installed row, which is the opposite of closed.
 *
 * So a plugin declares its own, in its own namespace: `<pluginId>:<name>`. The TYPE carries
 * the namespace's mandatory dot (a plugin id is dotted, `PLUGIN_ID_PATTERN`), and that is what
 * keeps this union from collapsing into "any string with a colon": every engine cap is
 * `<domain-plural>:<verb>` with no dot, so `containers:reed` is neither a {@link Cap} nor a
 * {@link PluginCap} and a typo still refuses to compile. The FORM is validated by
 * `PluginCapSchema` in `plugin.ts`, beside `PluginIdSchema` and `LocalNameSchema` — a
 * namespace IS a plugin id, and that law gets one spelling.
 */
export type PluginCap = `${string}.${string}:${string}`;

/**
 * A capability as a MANIFEST, an ACTION or a GRANT ROW names it: the engine's own, or a
 * plugin's. Credentials are deliberately not in this set — a token carries {@link Cap} — and
 * ADR 0035 records why: a mint attenuates the engine's flat ceiling, while a plugin
 * capability is held by a row at a node.
 */
export type AuthoredCap = Cap | PluginCap;

/**
 * A capability an authority QUESTION can name. The wildcard is excluded by signature, as it
 * has been since ADR 0011 §3: `*` is expanded rather than carried, and what it expands to is
 * the engine's closed set — never a plugin's namespaced name, which no expansion could
 * enumerate without asking the roster what happens to be installed.
 */
export type AskableCap = Exclude<Cap, "*"> | PluginCap;

/**
 * Whether a name is one of the engine's own. A predicate rather than `CAPS.includes(cap)` at
 * each site, because `includes` on the enum tuple cannot be ASKED about a plugin cap: the
 * question "is this one of mine?" is exactly what the closed half has to answer for a value
 * out of the open union, and the answer narrows.
 */
export function isEngineCap(cap: AuthoredCap): cap is Cap {
  return (CAPS as readonly string[]).includes(cap);
}

/**
 * These require separate, version-bound consent; a capability grant alone never suffices.
 *
 * Declared over the open union so that a plugin capability can be TESTED against it and
 * always miss. Governed consent is bound to an artifact revision the engine acquired and
 * pinned; a plugin's own capability names nothing the engine could pin, so it is never
 * governed, and the membership test says so rather than a cast at each caller.
 */
export const GOVERNED_CAPS: readonly AuthoredCap[] = [
  "machines:run",
  "jobs:read",
  "jobs:input",
  "jobs:cancel",
  "locations:read",
  "locations:write",
  "locations:create",
  "operations:invoke",
  "services:invoke",
  "network:host",
];

/**
 * Whether a declared cap set covers one asked-for capability — the flat CEILING test, and the
 * one place the wildcard's reach is spelled for a ceiling. (The evaluator spells it again for
 * a grant row, per capability, because a deny row makes that a contest rather than a lookup.)
 *
 * `*` covers the engine's caps and stops there. A wildcard is the engine's own "everything",
 * and a plugin's namespaced capability is not the engine's to hand out by wildcard: it exists
 * to say something `CAPS` cannot, so holding it by accident would make the plugin's own gate
 * meaningless for exactly the principal most able to ignore it.
 */
export function hasCap(granted: readonly AuthoredCap[], needed: AskableCap): boolean {
  return granted.includes(needed) || (isEngineCap(needed) && granted.includes("*"));
}
