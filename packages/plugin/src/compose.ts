import {
  LocalNameSchema,
  PluginManifestSchema,
  type ActionSummary,
  type PluginManifest,
  type PluginRoster,
  type PluginRosterEntry,
} from "@manifold/protocol";
import { z } from "zod";
import type { AnyActionDef } from "./action.ts";

/**
 * A plugin as its package hands it over: what it declares, and the actions behind that
 * declaration. The server half adds handlers (`ServerPluginDef`); the web half adds
 * components. Both compose through this same shape, so the roster a browser renders and the
 * one a dispatcher enforces are built by one function from one kind of input.
 */
export interface PluginDef {
  readonly manifest: PluginManifest;
  readonly actions: readonly AnyActionDef[];
}

export interface CompositionAction {
  /** The declaring manifest, so a dispatcher can read `essential`, caps, and title without a second lookup. */
  readonly plugin: PluginManifest;
  readonly def: AnyActionDef;
}

export interface CompositionPanel {
  /** Owning plugin id. */
  readonly plugin: string;
  readonly title: string;
}

export interface CompositionSection {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly order: number;
}

export interface CompositionElement {
  readonly plugin: string;
  readonly title: string;
}

export interface CompositionTool {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
}

/**
 * The composed vocabulary: every registry the engine looks things up in, plus the roster
 * that publishes it.
 *
 * IMPORTANT — the registries include DISABLED plugins' contributions. This is deliberate and
 * load-bearing in both directions:
 *
 * - the server needs it to answer a dispatch with `plugin_disabled` rather than
 *   `unknown_action`, because those are different truths and a caller acts differently on
 *   each (retry after an admin re-enables, versus fix the name);
 * - the browser needs it to render a disabled panel or element as a placeholder that NAMES
 *   the plugin it is waiting for, rather than as a blank tile.
 *
 * So every consumer of these maps asks `enabled(pluginId)` before it acts on what it found.
 */
export interface Composition {
  readonly roster: PluginRoster;
  /** Keyed by FULL action name (`core.terminals.rename`). */
  readonly actions: ReadonlyMap<string, CompositionAction>;
  /** Keyed by FULL panel id (`core.shell.sidebar`), the id a `panel` tile surface names. */
  readonly panels: ReadonlyMap<string, CompositionPanel>;
  /** Sorted by declared `order`; ties keep registration order. */
  readonly sections: readonly CompositionSection[];
  /** Keyed by wire element type (`draw`) — the same string a scene element carries. */
  readonly elements: ReadonlyMap<string, CompositionElement>;
  readonly tools: readonly CompositionTool[];
  /** False for a disabled plugin AND for an id nothing composed. */
  enabled(id: string): boolean;
}

function refusalMessage(problems: readonly string[]): string {
  const detail = problems.map((problem) => `  - ${problem}`).join("\n");
  return `composition refused (${problems.length}):\n${detail}`;
}

/**
 * A composition that refuses to exist, naming every reason at once. Collisions are never
 * resolved by shadowing: two plugins claiming one name is an authoring bug, and the workspace
 * says so with both offenders' ids rather than silently picking a winner whose identity then
 * depends on registration order.
 */
export class CompositionError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(refusalMessage(problems));
    this.name = "CompositionError";
    this.problems = [...problems];
  }
}

/** Every claimant of a name, so a duplicate can be reported with all of its offenders. */
type Claims = Map<string, string[]>;

function claim(claims: Claims, name: string, claimant: string): void {
  const existing = claims.get(name);
  if (existing === undefined) claims.set(name, [claimant]);
  else existing.push(claimant);
}

function reportDuplicates(claims: Claims, noun: string, problems: string[]): void {
  for (const [name, claimants] of claims) {
    if (claimants.length < 2) continue;
    problems.push(`duplicate ${noun} "${name}" claimed by: ${claimants.join(", ")}`);
  }
}

/**
 * Published schemas are generated from the enforcing schemas, never written twice. `input` is
 * described as the caller SENDS it (defaults optional) and `result` as the caller RECEIVES it
 * — the two are different documents whenever a schema has a default or a transform.
 *
 * An unrepresentable schema (`z.void()` and friends) is an authoring bug in a door that is
 * supposed to be machine-readable, so it becomes a composition problem instead of a raw zod
 * throw from somewhere deep in a boot sequence.
 */
function publishSchema(
  schema: z.ZodType,
  io: "input" | "output",
  label: string,
  problems: string[],
): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io });
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    problems.push(`${label} cannot be published as JSON Schema: ${detail}`);
    return {};
  }
}

/**
 * Build the composition, or refuse. `disabled` is the workspace-global set of plugin ids an
 * administrator turned off (`core.plugins.setEnabled`); it changes what `enabled()` answers
 * and what the roster reports, and NOTHING else — validation and uniqueness are checked
 * across all defs whether enabled or not, so turning a plugin off can never mask a collision
 * that turning it back on would resurrect.
 */
export function composeRoster(
  defs: readonly PluginDef[],
  disabled: ReadonlySet<string>,
): Composition {
  const problems: string[] = [];
  const pluginIds: Claims = new Map();
  const actionNames: Claims = new Map();
  const panelIds: Claims = new Map();
  const sectionIds: Claims = new Map();
  const elementTypes: Claims = new Map();
  const toolIds: Claims = new Map();
  const eventIds: Claims = new Map();

  const roster: PluginRosterEntry[] = [];
  const actions = new Map<string, CompositionAction>();
  const panels = new Map<string, CompositionPanel>();
  const sections: CompositionSection[] = [];
  const elements = new Map<string, CompositionElement>();
  const tools: CompositionTool[] = [];
  const known = new Set<string>();

  for (const [index, def] of defs.entries()) {
    const parsed = PluginManifestSchema.safeParse(def.manifest);
    if (!parsed.success) {
      // Named by whatever identity survived: an unparseable manifest may not even have an id.
      const label =
        typeof def.manifest.id === "string" && def.manifest.id.length > 0
          ? `"${def.manifest.id}"`
          : `at index ${index}`;
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("; ");
      problems.push(`invalid manifest ${label}: ${issues}`);
      continue;
    }
    const manifest = parsed.data;
    claim(pluginIds, manifest.id, manifest.id);
    known.add(manifest.id);

    const summaries: ActionSummary[] = [];
    for (const action of def.actions) {
      const local = LocalNameSchema.safeParse(action.name);
      if (!local.success) {
        problems.push(
          `plugin "${manifest.id}" declares action name "${action.name}", which is not a local name (starts lowercase, no dots, <=32 chars)`,
        );
        continue;
      }
      const name = `${manifest.id}.${local.data}`;
      claim(actionNames, name, manifest.id);
      for (const cap of action.caps) {
        const covered =
          manifest.capabilities.includes(cap) ||
          (cap !== "*" && manifest.capabilities.includes("*"));
        if (covered) continue;
        problems.push(
          `action "${name}" requires cap "${cap}" outside its manifest capabilities [${manifest.capabilities.join(", ")}]`,
        );
      }
      summaries.push({
        name,
        title: action.title,
        caps: [...action.caps],
        ...(action.cleanup === true ? { cleanup: true } : {}),
        input: publishSchema(action.input, "input", `action "${name}" input`, problems),
        result: publishSchema(action.result, "output", `action "${name}" result`, problems),
      });
      actions.set(name, { plugin: manifest, def: action });
    }

    for (const panel of manifest.contributes.panels) {
      const id = `${manifest.id}.${panel.id}`;
      claim(panelIds, id, manifest.id);
      panels.set(id, { plugin: manifest.id, title: panel.title });
    }
    // Sections, elements and tools are named GLOBALLY rather than per plugin: a section is a
    // slot in one sidebar, an element type is a wire kind a scene doc stores, and a tool id is
    // what presence publishes as the peer's current tool. Two plugins claiming one of those
    // would be two plugins claiming one thing, which is exactly what D5 refuses.
    for (const section of manifest.contributes.sections) {
      claim(sectionIds, section.id, manifest.id);
      sections.push({
        id: section.id,
        plugin: manifest.id,
        title: section.title,
        order: section.order,
      });
    }
    for (const element of manifest.contributes.elements) {
      claim(elementTypes, element.type, manifest.id);
      elements.set(element.type, { plugin: manifest.id, title: element.title });
    }
    for (const tool of manifest.contributes.tools) {
      claim(toolIds, tool.id, manifest.id);
      tools.push({ id: tool.id, plugin: manifest.id, title: tool.title });
    }
    // Events are reserved for the wave-2 plane (ADR 0012) — nothing consumes them yet, but
    // an event id is a GLOBAL topic name the moment it exists, so collisions refuse NOW
    // rather than on the wave that would have had to break someone to fix them.
    for (const event of manifest.contributes.events) {
      claim(eventIds, event.id, manifest.id);
    }

    roster.push({
      manifest,
      enabled: !disabled.has(manifest.id),
      source: "builtin",
      actions: summaries,
    });
  }

  reportDuplicates(pluginIds, "plugin id", problems);
  reportDuplicates(actionNames, "action", problems);
  reportDuplicates(panelIds, "panel", problems);
  reportDuplicates(sectionIds, "section", problems);
  reportDuplicates(elementTypes, "element type", problems);
  reportDuplicates(toolIds, "tool", problems);
  reportDuplicates(eventIds, "event", problems);
  if (problems.length > 0) throw new CompositionError(problems);

  sections.sort((left, right) => left.order - right.order);

  return {
    roster,
    actions,
    panels,
    sections,
    elements,
    tools,
    enabled: (id) => known.has(id) && !disabled.has(id),
  };
}
