import {
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  ENGINE_NAMESPACE_PREFIX,
  LocalNameSchema,
  PluginManifestSchema,
  type ActionSummary,
  type PlacementTraits,
  type PluginDataVersion,
  type PluginDependency,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginRefusalReason,
  type PluginRoster,
  type PluginRosterEntry,
} from "@manifold/protocol";
import { z } from "zod";
import type { AnyActionDef } from "./action.ts";
import type { PluginLifecycle } from "./lifecycle.ts";
import {
  compareDataVersion,
  formatDataVersion,
  planDataMigration,
  type PluginMigration,
} from "./storage.ts";

/**
 * A plugin as its package hands it over: what it declares, and the code behind that
 * declaration. The server half adds handlers (`ServerPluginDef`); the web half adds
 * components. Both compose through this same shape, so the roster a browser renders and the
 * one a dispatcher enforces are built by one function from one kind of input.
 */
export interface PluginDef {
  readonly manifest: PluginManifest;
  readonly actions: readonly AnyActionDef[];
  /**
   * Transition hooks. Optional, and most plugins declare none: a plugin whose state lives in
   * documents, the roster and its own actions has nothing to do when a toggle moves.
   */
  readonly lifecycle?: PluginLifecycle;
  /**
   * Named data migrations over this plugin's `ctx.storage`. Declaring any of them requires
   * declaring `manifest.dataVersion` — a migration with no version to reach is a
   * transformation nobody can decide to run.
   */
  readonly migrations?: readonly PluginMigration[];
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
  /**
   * How the placement algebra must treat this element kind (G1). Manifest data, resolved
   * here rather than at every reader: a manifest that declares nothing gets
   * `DEFAULT_ELEMENT_PLACEMENT_TRAITS`, so consumers see traits, never an absence they have
   * to know the default for. The trait-driven rules engine consumes this in the conversion
   * batch; publishing it now is what lets that conversion be a change of consumer rather
   * than a change of contract.
   */
  readonly placement: PlacementTraits;
}

export interface CompositionTool {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
}

/** A plugin's stored data as the ledger knows it: what was stamped, and what already ran. */
export interface PluginStoredData {
  readonly version: PluginDataVersion | null;
  readonly applied: readonly string[];
}

/** Who last changed a plugin's enablement, and when. Published on the roster row. */
export interface PluginAttribution {
  readonly by: string;
  readonly at: number;
}

/**
 * Everything a composition needs to know that is NOT in the definitions: durable facts the
 * engine reads out of the workspace, plus runtime facts it remembers. All optional, because
 * the browser composes the same definitions with none of them — a client renders the roster
 * the server published rather than recomputing its verdicts.
 */
export interface CompositionEnv {
  /** Ids the ENGINE registered itself; they publish as `source: "builtin"`. */
  readonly builtins?: ReadonlySet<string>;
  /**
   * Element-type reservations: wire type → the plugin that first claimed it. A reservation
   * OUTLIVES the plugin's presence in the build, which is the point — a canvas full of
   * `draw` elements must not be reinterpreted by whatever ships next under that name.
   */
  readonly elementOwners?: ReadonlyMap<string, string>;
  /** Stamped data version + applied migration names, per plugin. */
  readonly dataState?: ReadonlyMap<string, PluginStoredData>;
  /** The outcome of the last lifecycle fan-out per plugin; absent means `ok`. */
  readonly lifecycle?: ReadonlyMap<string, PluginLifecycleState>;
  /** Enablement attribution per plugin, written at the door. */
  readonly attribution?: ReadonlyMap<string, PluginAttribution>;
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
  /**
   * THE order: topological over `dependencies` ∪ `after`, ties broken by lexicographic id.
   * Derived, deterministic and total, and it is the order lifecycle hooks fan out in — which
   * is exactly why it may not be incidental (ADR 0013 §5).
   */
  readonly order: readonly string[];
  /** Migrations the engine still owes each plugin, keyed by plugin id. Empty for most. */
  readonly pendingMigrations: ReadonlyMap<string, readonly PluginMigration[]>;
  /** False for a disabled plugin AND for an id nothing composed. */
  enabled(id: string): boolean;
  /** True for a row the ENGINE published (`source: "builtin"`); such rows have no toggle. */
  builtin(id: string): boolean;
  /**
   * ENABLED plugins that declare `id` a required dependency — the offenders a disable must
   * name. There is no disable cascade: other principals' surfaces do not vanish because
   * somebody toggled a dependency (ADR 0013 §5.4).
   */
  requiredBy(id: string): readonly string[];
  /** Required dependencies of `id` that are not currently enabled — what an enable must name. */
  unmet(id: string): readonly string[];
  /** Enabled plugins declared incompatible with `id`, in either direction. */
  conflicts(id: string): readonly string[];
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

/** A manifest's declared dependencies as entry pairs, sorted so every report is stable. */
function dependencyEntries(
  manifest: PluginManifest,
): readonly (readonly [string, PluginDependency])[] {
  return Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) =>
    left < right ? -1 : 1,
  );
}

/**
 * Topological order over `dependencies` ∪ `after`, ties broken by lexicographic id — Kahn's
 * algorithm with a sorted ready set, which is what makes the result TOTAL rather than merely
 * valid. A cycle leaves nodes unemitted; the caller reports them as offenders.
 */
function topologicalOrder(
  ids: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): { readonly order: readonly string[]; readonly cyclic: readonly string[] } {
  const remaining = new Map<string, Set<string>>();
  for (const id of ids) remaining.set(id, new Set(edges.get(id) ?? []));
  const order: string[] = [];
  for (;;) {
    const ready = [...remaining]
      .filter(([, blockers]) => blockers.size === 0)
      .map(([id]) => id)
      .sort();
    const next = ready[0];
    if (next === undefined) break;
    remaining.delete(next);
    order.push(next);
    for (const blockers of remaining.values()) blockers.delete(next);
  }
  return { order, cyclic: [...remaining.keys()].sort() };
}

/**
 * Build the composition, or refuse.
 *
 * `disabled` is the workspace-global set of plugin ids an administrator turned off; it
 * changes what `enabled()` answers and what the roster reports, and NOTHING else — every
 * manifest is validated and every name checked for collisions whether its plugin is enabled
 * or not, so turning a plugin off can never mask a collision that turning it back on would
 * resurrect.
 *
 * `env` carries the durable and runtime facts (below). What composition refuses on is
 * deliberately narrow: STRUCTURAL truths that no toggle can fix — a required dependency that
 * is not in the build, a dependency cycle, a squatted `engine.` id, a squatted element type,
 * and stored data an enabled plugin's code cannot safely read. Everything a toggle CAN fix —
 * a dependency that is merely disabled, an incompatible pair, an unknown id — refuses at the
 * door instead, where an actor is present to be told what is in the way (ADR 0013 §5).
 * Composition never disables a plugin nobody named: a cascade in workspace-global state is
 * other principals' surfaces vanishing without their consent.
 */
export function composeRoster(
  defs: readonly PluginDef[],
  disabled: ReadonlySet<string>,
  env: CompositionEnv = {},
): Composition {
  const builtins = env.builtins ?? new Set<string>();
  const problems: string[] = [];
  const pluginIds: Claims = new Map();
  const actionNames: Claims = new Map();
  const panelIds: Claims = new Map();
  const sectionIds: Claims = new Map();
  const elementTypes: Claims = new Map();
  const toolIds: Claims = new Map();
  const eventIds: Claims = new Map();

  const manifests = new Map<string, PluginManifest>();
  const summaries = new Map<string, ActionSummary[]>();
  const actions = new Map<string, CompositionAction>();
  const panels = new Map<string, CompositionPanel>();
  const sections: CompositionSection[] = [];
  const elements = new Map<string, CompositionElement>();
  const tools: CompositionTool[] = [];
  const pendingMigrations = new Map<string, readonly PluginMigration[]>();

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
    manifests.set(manifest.id, manifest);

    // The `engine.` namespace is the engine's alone. A plugin claiming it would publish a row
    // indistinguishable from a builtin door — the one row a client renders without a toggle —
    // so the squat is refused by name rather than trusted (D5).
    if (manifest.id.startsWith(ENGINE_NAMESPACE_PREFIX) && !builtins.has(manifest.id)) {
      problems.push(
        `plugin "${manifest.id}" claims the reserved "${ENGINE_NAMESPACE_PREFIX}" namespace, which only the engine's own builtin doors may use`,
      );
    }

    const published: ActionSummary[] = [];
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
      published.push({
        name,
        title: action.title,
        caps: [...action.caps],
        ...(action.cleanup === true ? { cleanup: true } : {}),
        input: publishSchema(action.input, "input", `action "${name}" input`, problems),
        result: publishSchema(action.result, "output", `action "${name}" result`, problems),
      });
      actions.set(name, { plugin: manifest, def: action });
    }
    summaries.set(manifest.id, published);

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
      elements.set(element.type, {
        plugin: manifest.id,
        title: element.title,
        placement: element.placement ?? DEFAULT_ELEMENT_PLACEMENT_TRAITS,
      });
      // ELEMENT-TYPE OWNERSHIP. The reservation is a tombstone: it survives the owner being
      // disabled, going dormant, or leaving the build entirely, because the documents that
      // stored the type do not. A different plugin claiming a reserved type would silently
      // reinterpret every existing element of that kind, so it is refused with both names.
      const owner = env.elementOwners?.get(element.type);
      if (owner !== undefined && owner !== manifest.id) {
        problems.push(
          `element type "${element.type}" is reserved by "${owner}"; "${manifest.id}" cannot claim it`,
        );
      }
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

    // MIGRATIONS AND DATA VERSION. The declaration is checked here; the running happens in
    // the host, which owns the storage the migration writes through.
    const migrations = def.migrations ?? [];
    const migrationNames: Claims = new Map();
    for (const migration of migrations) {
      claim(migrationNames, migration.name, manifest.id);
      if (manifest.dataVersion === undefined) {
        problems.push(
          `plugin "${manifest.id}" declares migration "${migration.name}" without a manifest dataVersion to reach`,
        );
        continue;
      }
      if (compareDataVersion(migration.to, manifest.dataVersion) > 0) {
        problems.push(
          `plugin "${manifest.id}" migration "${migration.name}" targets ${formatDataVersion(migration.to)}, past the ${formatDataVersion(manifest.dataVersion)} its code declares`,
        );
      }
    }
    reportDuplicates(migrationNames, `migration in "${manifest.id}"`, problems);

    // The stored-data verdict applies to plugins that are about to SERVE. A disabled
    // plugin's data is retained and untouched, so its version cannot hurt anyone; it is
    // re-checked at the enablement door, where the actor can be told why (ADR 0013 §7).
    if (!disabled.has(manifest.id)) {
      const stored = env.dataState?.get(manifest.id);
      const plan = planDataMigration({
        pluginId: manifest.id,
        declared: manifest.dataVersion,
        stored: stored?.version ?? null,
        applied: new Set(stored?.applied ?? []),
        migrations,
      });
      if (plan.kind === "refused") problems.push(plan.detail);
      if (plan.kind === "migrate") pendingMigrations.set(manifest.id, plan.run);
    }
  }

  reportDuplicates(pluginIds, "plugin id", problems);
  reportDuplicates(actionNames, "action", problems);
  reportDuplicates(panelIds, "panel", problems);
  reportDuplicates(sectionIds, "section", problems);
  reportDuplicates(elementTypes, "element type", problems);
  reportDuplicates(toolIds, "tool", problems);
  reportDuplicates(eventIds, "event", problems);

  /*
    DEPENDENCIES. Two axes, deliberately separate (NeoForge's and Home Assistant's shape):
    `dependencies` says what must be THERE, `after` says only what must come FIRST. A missing
    `after` target is ignored — it is an ordering wish about a plugin that may legitimately
    not exist. A missing REQUIRED dependency is structural: no toggle produces it, so it
    refuses here with both names.
  */
  const blockers = new Map<string, Set<string>>();
  for (const id of manifests.keys()) blockers.set(id, new Set());
  for (const [id, manifest] of manifests) {
    // Present by construction: `blockers` was seeded from the same map.
    const edgeInto = blockers.get(id) ?? new Set<string>();
    for (const [target, dependency] of dependencyEntries(manifest)) {
      if (target === id) {
        problems.push(`plugin "${id}" declares a dependency on itself`);
        continue;
      }
      const present = manifests.has(target);
      if (dependency.type === "required" && !present) {
        const reason = dependency.reason === undefined ? "" : ` (${dependency.reason})`;
        problems.push(`plugin "${id}" requires plugin "${target}", which is not composed${reason}`);
      }
      // An incompatibility is an ordering non-statement: the two never run together, so
      // there is nothing to order. Requirements and optional dependencies both order.
      if (dependency.type !== "incompatible" && present) edgeInto.add(target);
    }
    for (const target of manifest.after ?? []) {
      if (target === id) {
        problems.push(`plugin "${id}" declares itself in "after"`);
        continue;
      }
      if (manifests.has(target)) edgeInto.add(target);
    }
  }

  const { order, cyclic } = topologicalOrder([...manifests.keys()], blockers);
  if (cyclic.length > 0) {
    problems.push(`dependency cycle among: ${cyclic.join(", ")}`);
  }

  if (problems.length > 0) throw new CompositionError(problems);

  sections.sort((left, right) => left.order - right.order);

  const isEnabled = (id: string): boolean => manifests.has(id) && !disabled.has(id);

  const requiredBy = (id: string): readonly string[] =>
    order.filter(
      (candidate) =>
        isEnabled(candidate) && manifests.get(candidate)?.dependencies?.[id]?.type === "required",
    );

  const unmet = (id: string): readonly string[] => {
    const manifest = manifests.get(id);
    if (manifest === undefined) return [];
    return dependencyEntries(manifest)
      .filter(([target, dependency]) => dependency.type === "required" && !isEnabled(target))
      .map(([target]) => target);
  };

  const conflicts = (id: string): readonly string[] => {
    const manifest = manifests.get(id);
    if (manifest === undefined) return [];
    const declaredHere = dependencyEntries(manifest)
      .filter(([target, dependency]) => dependency.type === "incompatible" && isEnabled(target))
      .map(([target]) => target);
    const declaredThere = order.filter(
      (candidate) =>
        candidate !== id &&
        isEnabled(candidate) &&
        manifests.get(candidate)?.dependencies?.[id]?.type === "incompatible",
    );
    return [...new Set([...declaredHere, ...declaredThere])].sort();
  };

  /*
    THE ROSTER ROW. `enabled` is the ADMINISTRATIVE truth and the only one: there is no
    derived "effectively off" state for downstream code to branch on, because there is no
    cascade. `refusal` is the named class that makes this row's enablement not freely
    changeable right now — a builtin door, an essential plugin, a disabled plugin whose
    required dependency is missing, an enabled plugin sharing the workspace with a declared
    incompatible peer. It is advice for a UI, always re-derived, never a stored fact.
  */
  const rosterRefusal = (manifest: PluginManifest): PluginRefusalReason | null => {
    if (builtins.has(manifest.id)) return "builtin";
    if (isEnabled(manifest.id)) {
      if (conflicts(manifest.id).length > 0) return "incompatible_dependency";
      if (manifest.essential === true) return "essential";
      return null;
    }
    if (unmet(manifest.id).length > 0) return "dependency_disabled";
    return null;
  };

  const roster: PluginRosterEntry[] = [...manifests].map(([id, manifest]) => {
    const lifecycle = env.lifecycle?.get(id);
    const refusal = rosterRefusal(manifest);
    const attribution = env.attribution?.get(id);
    return {
      manifest,
      enabled: isEnabled(id),
      source: builtins.has(id) ? "builtin" : "plugin",
      actions: summaries.get(id) ?? [],
      ...(lifecycle === undefined || lifecycle === "ok" ? {} : { lifecycle }),
      ...(refusal === null ? {} : { refusal }),
      ...(attribution === undefined
        ? {}
        : { changedBy: attribution.by, changedAt: attribution.at }),
    };
  });

  return {
    roster,
    actions,
    panels,
    sections,
    elements,
    tools,
    order,
    pendingMigrations,
    enabled: isEnabled,
    builtin: (id) => builtins.has(id),
    requiredBy,
    unmet,
    conflicts,
  };
}
