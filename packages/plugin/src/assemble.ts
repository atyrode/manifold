import {
  CORE_NAMESPACE_PREFIX,
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  DEFAULT_SECTION_PRESENTATION,
  ENGINE_NAMESPACE_PREFIX,
  LocalNameSchema,
  PluginManifestSchema,
  type ActionSummary,
  type DisciplineDeclaration,
  type PlacementTraits,
  type PluginDataVersion,
  type PluginDependency,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginRefusalReason,
  type PluginRoster,
  type PluginRosterEntry,
  type SectionPresentation,
  type SettingDef,
} from "@manifold/protocol";
import { z } from "zod";
import type { AnyActionDef } from "./action.ts";
import type { PluginLifecycle } from "./lifecycle.ts";
import { settingRefId } from "./settings.ts";
import {
  compareDataVersion,
  formatDataVersion,
  planDataMigration,
  type PluginMigration,
} from "./storage.ts";

/**
 * A plugin as its package hands it over: what it declares, and the code behind that
 * declaration. The server half adds handlers (`ServerPluginDef`); the web half adds
 * components. Both assemble through this same shape, so the roster a browser renders and the
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
  /**
   * PER-TYPE PAYLOAD SCHEMAS for the element kinds this plugin's manifest contributes, keyed
   * by wire element type (ADR 0013 §16 clause 4).
   *
   * They live on the DEFINITION rather than the manifest because a Zod schema is code and
   * manifests stay inert data (ADR 0010 rule 2) — the manifest names the type and declares its
   * placement traits, the registration declares what a record of that type must contain. The
   * protocol's own element schema is a NEUTRAL envelope and validates none of this: it holds
   * the geometry and bounds the payload, and the payload's meaning is its owner's.
   *
   * A contribution with no entry here declares that its records carry no payload the engine
   * should police, which is a real declaration rather than an oversight — the same shape
   * `dormant`'s absence has (ADR 0013 §4). A schema is parsed against the payload alone, so it
   * is written as the plugin sees its own fields (`z.strictObject({ containerId: … })`) and
   * never has to restate the envelope.
   */
  readonly elements?: Readonly<Record<string, z.ZodType>>;
}

export interface AssemblyAction {
  /** The declaring manifest, so a dispatcher can read `essential`, caps, and title without a second lookup. */
  readonly plugin: PluginManifest;
  readonly def: AnyActionDef;
}

export interface AssemblyPanel {
  /** Owning plugin id. */
  readonly plugin: string;
  readonly title: string;
  /**
   * What this panel calls the arrangement it holds INSIDE itself, when it declared one
   * (`PanelDefSchema.arranges`). Undefined ≡ nothing to arrange in there — the answer for
   * every panel that never said otherwise. Carried through rather than re-read from the
   * manifest so a reader resolving a `panel` ref learns everything about that panel in one
   * lookup, exactly as it learns the title.
   */
  readonly arranges?: { readonly title: string } | undefined;
}

export interface AssemblySection {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly order: number;
  /**
   * How this row draws: a collapsible disclosure, or a plain row that draws itself end to
   * end. RESOLVED here rather than at every reader, exactly as `AssemblyElement.placement`
   * is — a manifest that declares nothing yields `DEFAULT_SECTION_PRESENTATION`, so a
   * consumer sees a presentation and never an absence it has to know the default for.
   *
   * It is a rendering fact and nothing else. Both kinds inhabit THIS one registry in THIS
   * one order, so arrange mode, the per-principal order and the owner-naming DOM are
   * indifferent to the value; only the component that fills the row reads it.
   */
  readonly presentation: SectionPresentation;
  /**
   * WHICH CLUSTER this row declared, or undefined for "its own". Rows sharing a cluster paint
   * side by side as one horizontal row at the cluster's earliest member (`clusteredSections`,
   * `layout.ts`); absent is not defaulted to anything, because there is no such thing as a
   * default cluster — a row without one IS its own unit.
   *
   * Carried verbatim from the manifest and nothing more. The engine never resolves membership,
   * never orders a cluster and never learns who is in one: a word is the whole vocabulary, so
   * `core.keys` and `core.plugins` sitting side by side is a fact of their two manifests
   * (issue #91) rather than of any registry, panel or floor file.
   */
  readonly cluster?: string;
  /**
   * WHICH SETTING gates this row, or undefined for "unconditional". One of the owning
   * manifest's own `contributes.settings` ids — assembly refuses anything else, naming the
   * plugin and the setting — carried verbatim, because the value it resolves to is a
   * PRINCIPAL's and this registry is everybody's.
   *
   * The rule it feeds is `visibleSections` (`settings.ts`) and only that: a row whose setting
   * reads false is dropped at the composition seam where the principal's delta is known. So
   * this registry keeps every declared row, exactly as it keeps a disabled plugin's, and the
   * per-principal answer stays a function of the seam rather than of the assembly.
   */
  readonly setting?: string;
}

export interface AssemblyElement {
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
  /**
   * The owner's payload schema, or null when it declared none. Collected here for the same
   * reason `placement` is: one resolution, at assembly time, so the boundary that validates a
   * record does a map lookup instead of walking definitions (ADR 0013 §16 clause 5).
   */
  readonly payload: z.ZodType | null;
}

/**
 * One contributed CONTAINER DISCIPLINE and who renders it (#110). The declaration is the
 * manifest's verbatim — the placement algebra reads it unchanged — and `plugin` is what
 * lets a reader answer the second question a discipline raises: this container's renderer
 * is not painting, is that because its plugin is OFF (D4′, the engine-owned placeholder)
 * or because nothing here declares the discipline at all.
 */
export interface AssemblyDiscipline {
  readonly plugin: string;
  readonly declaration: DisciplineDeclaration;
}

/**
 * One contributed SETTING and who declares it, keyed in the registry by its full ref. The
 * declaration is the manifest's verbatim; what a given principal reads is composed at the seam
 * (`composeSettings`, `settings.ts`), because a registry is everybody's and a value is one
 * principal's. This index is what makes a write refusable: a door can ask "does this
 * declaration exist" without re-walking the roster.
 */
export interface AssemblySetting {
  readonly plugin: string;
  readonly declaration: SettingDef;
}

export interface AssemblyTool {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
}

/**
 * One declared event kind, and who may originate it (ADR 0012). The index this inhabits is
 * what turns `contributes.events` from a reserved field into a MECHANISM: an emission whose
 * kind nobody declared is refused by name, so the vocabulary a live workspace can emit is
 * closed and published while the vocabulary a build can declare stays open.
 */
export interface AssemblyEvent {
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
 * Everything an assembly needs to know that is NOT in the definitions: durable facts the
 * engine reads out of the workspace, plus runtime facts it remembers. All optional, because
 * the browser assembles the same definitions with none of them — a client renders the roster
 * the server published rather than recomputing its verdicts.
 */
export interface AssemblyEnv {
  /** Ids the ENGINE registered itself; they publish as `source: "builtin"`. */
  readonly builtins?: ReadonlySet<string>;
  /**
   * The ids the SHIPPED DISTRIBUTION registers — the permitted inhabitants of the `core.`
   * namespace, derived by the composition root from its own registration file
   * (`SHIPPED_PLUGIN_IDS` in `packages/server/src/assembly.ts`) and never written out as a
   * second list anybody could let drift (invariant 14).
   *
   * ABSENT MEANS UNKNOWN, not empty: a caller that declares no distribution is not the shipped
   * distribution — a unit test assembling two manifests, or a browser rebuilding a roster the
   * server already ruled on — and refusing every `core.` id against a set nobody supplied
   * would be the engine inventing a verdict from missing information. The production wiring is
   * what makes the reservation real, and `verify:axioms` composes through it.
   */
  readonly distribution?: ReadonlySet<string>;
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
 * The assembled vocabulary: every registry the engine looks things up in, plus the roster
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
export interface Assembly {
  readonly roster: PluginRoster;
  /** Keyed by FULL action name (`core.terminals.rename`). */
  readonly actions: ReadonlyMap<string, AssemblyAction>;
  /** Keyed by FULL panel id (`core.shell.sidebar`), the id a `panel` tile ref names. */
  readonly panels: ReadonlyMap<string, AssemblyPanel>;
  /**
   * THE section registry — the only one, holding every row of the sidebar whatever its
   * `presentation`, in the only order. Sorted by declared `order`; ties keep registration
   * order. A second list for plain rows would be a second answer to "what is in the sidebar,
   * and in what sequence", which is the thing the per-principal arrangement reorders.
   */
  readonly sections: readonly AssemblySection[];
  /** Keyed by wire element type (`draw`) — the same string a scene element carries. */
  readonly elements: ReadonlyMap<string, AssemblyElement>;
  /**
   * Keyed by DISCIPLINE id (`canvas`) — the same string a container row carries and the
   * key `ProjectionRegistry.renderer` is looked up by. Disabled plugins are in here for
   * the reason every other registry holds them: their containers are still in the index,
   * and a disable decides who renders one, never whether it composes.
   */
  readonly disciplines: ReadonlyMap<string, AssemblyDiscipline>;
  /**
   * Keyed by SETTING ref (`core.canvas.new-canvas`) — a preference is a plugin's own
   * vocabulary, so unlike a section it is named by the pair. Disabled plugins are in here for
   * the reason every other registry holds them: a principal's stored preferences outlive a
   * plugin being switched off, and the manager lists a disabled row's pane precisely while
   * somebody is deciding whether to switch it back on.
   */
  readonly settings: ReadonlyMap<string, AssemblySetting>;
  readonly tools: readonly AssemblyTool[];
  /**
   * THE DECLARED-TOPICS INDEX: event kind → the plugin that may originate it. Keyed by kind
   * alone, because a kind is claimed globally (D5) and a topic says WHOSE — an index keyed by
   * the pair would make a subscriber's match depend on which plugin currently implements a
   * concept.
   *
   * Iteration order is SORTED by kind rather than by registration, because this index is
   * published vocabulary: a reader diffing two builds' event surfaces should see what changed,
   * not where somebody moved a registration line.
   */
  readonly events: ReadonlyMap<string, AssemblyEvent>;
  /**
   * THE order: topological over `dependencies` ∪ `after`, ties broken by lexicographic id.
   * Derived, deterministic and total, and it is the order lifecycle hooks fan out in — which
   * is exactly why it may not be incidental (ADR 0013 §5).
   */
  readonly order: readonly string[];
  /** Migrations the engine still owes each plugin, keyed by plugin id. Empty for most. */
  readonly pendingMigrations: ReadonlyMap<string, readonly PluginMigration[]>;
  /** False for a disabled plugin AND for an id nothing assembled. */
  enabled(id: string): boolean;
  /** True for a row the ENGINE published (`source: "builtin"`); such rows have no toggle. */
  builtin(id: string): boolean;
  /**
   * ENABLED plugins that declare `id` a required dependency — the offenders a disable must
   * name. There is no disable cascade: other principals' refs do not vanish because
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
  return `assembly refused (${problems.length}):\n${detail}`;
}

/**
 * A assembly that refuses to exist, naming every reason at once. Collisions are never
 * resolved by shadowing: two plugins claiming one name is an authoring bug, and the workspace
 * says so with both offenders' ids rather than silently picking a winner whose identity then
 * depends on registration order.
 */
export class AssemblyError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(refusalMessage(problems));
    this.name = "AssemblyError";
    this.problems = [...problems];
  }
}

/**
 * Every claimant of a name, so a duplicate can be reported with all of its offenders.
 * Exported from this package for the two other registries that compose claimed names — the
 * binding table (`bindings.ts`) and the browser's four registration-time channels
 * (`buildBrowserAssembly`, `packages/web/src/plugin-host.tsx`) — because "two plugins claimed
 * one thing" must read the same way whichever vocabulary it happened in.
 */
export type Claims = Map<string, string[]>;

export function claim(claims: Claims, name: string, claimant: string): void {
  const existing = claims.get(name);
  if (existing === undefined) claims.set(name, [claimant]);
  else existing.push(claimant);
}

export function reportDuplicates(claims: Claims, noun: string, problems: string[]): void {
  for (const [name, claimants] of claims) {
    if (claimants.length < 2) continue;
    problems.push(`duplicate ${noun} "${name}" claimed by: ${claimants.join(", ")}`);
  }
}

/**
 * THE CONTRIBUTED HALF OF THE PLACEMENT VOCABULARY (G1): element type → the traits its
 * manifest declared, derived from a published ROSTER rather than from a live assembly.
 *
 * The roster is what both halves of the system actually hold — the server pushes it, the
 * browser receives it, and the placement executor is constructed from it — so deriving the
 * table here means the algebra reads the same declaration a stranger's agent reads at
 * `GET /api/plugins`, with no second source to disagree.
 *
 * DISABLED plugins are included, deliberately, for the same reason the assembly's
 * registries are: their elements are still in the documents. A canvas full of a disabled
 * plugin's elements must stay legal to move and remove (D12 — creation dies on a disable,
 * cleanup survives), and an element whose traits vanished would become unplaceable and
 * un-unplaceable at once, which is a canvas nobody can tidy.
 */
export function rosterElementTraits(roster: PluginRoster): ReadonlyMap<string, PlacementTraits> {
  const traits = new Map<string, PlacementTraits>();
  for (const entry of roster) {
    for (const element of entry.manifest.contributes.elements) {
      // Absence resolves to the default HERE too, so a reader of this table never has to
      // know the rule — the same reason `assembleRoster` resolves it into its own registry.
      traits.set(element.type, element.placement ?? DEFAULT_ELEMENT_PLACEMENT_TRAITS);
    }
  }
  return traits;
}

/**
 * Published schemas are generated from the enforcing schemas, never written twice. `input` is
 * described as the caller SENDS it (defaults optional) and `result` as the caller RECEIVES it
 * — the two are different documents whenever a schema has a default or a transform.
 *
 * An unrepresentable schema (`z.void()` and friends) is an authoring bug in a door that is
 * supposed to be machine-readable, so it becomes an assembly problem instead of a raw zod
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
 * THE panel naming rule, in one place.
 *
 * A panel id on the wire is the contributing plugin's id and the panel's local id joined by a
 * dot, which is why a panel — unlike a section, an element type or a tool — cannot collide
 * across plugins by accident. The claim loop below computes it, and so does anything that has
 * to NAME a panel it did not read out of an assembly: the two `assembly.ts` files build the
 * default workspace tree's leaves this way. Exported so that stays one rule rather than a
 * string template copied into the files that happen to need it (invariant 14).
 */
export function panelRefId(pluginId: string, panelId: string): string {
  return `${pluginId}.${panelId}`;
}

/**
 * Build the assembly, or refuse.
 *
 * `disabled` is the workspace-global set of plugin ids an administrator turned off; it
 * changes what `enabled()` answers and what the roster reports, and NOTHING else — every
 * manifest is validated and every name checked for collisions whether its plugin is enabled
 * or not, so turning a plugin off can never mask a collision that turning it back on would
 * resurrect.
 *
 * `env` carries the durable and runtime facts (below). What assembly refuses on is
 * deliberately narrow: STRUCTURAL truths that no toggle can fix — a required dependency that
 * is not in the build, a dependency cycle, a squatted `engine.` or `core.` id, a squatted
 * element type, and stored data an enabled plugin's code cannot safely read. Everything a
 * toggle CAN fix — a dependency that is merely disabled, an incompatible pair, an unknown id
 * — refuses at the door instead, where an actor is present to be told what is in the way
 * (ADR 0013 §5).
 * Assembly never disables a plugin nobody named: a cascade in workspace-global state is
 * other principals' refs vanishing without their consent.
 */
export function assembleRoster(
  defs: readonly PluginDef[],
  disabled: ReadonlySet<string>,
  env: AssemblyEnv = {},
): Assembly {
  const builtins = env.builtins ?? new Set<string>();
  const distribution = env.distribution ?? null;
  const problems: string[] = [];
  const pluginIds: Claims = new Map();
  const actionNames: Claims = new Map();
  const panelIds: Claims = new Map();
  const sectionIds: Claims = new Map();
  const elementTypes: Claims = new Map();
  const disciplineIds: Claims = new Map();
  const toolIds: Claims = new Map();
  const eventIds: Claims = new Map();
  const seatPanels: Claims = new Map();
  const routeSegments: Claims = new Map();
  const settingRefs: Claims = new Map();

  const manifests = new Map<string, PluginManifest>();
  const summaries = new Map<string, ActionSummary[]>();
  const actions = new Map<string, AssemblyAction>();
  const panels = new Map<string, AssemblyPanel>();
  const sections: AssemblySection[] = [];
  const elements = new Map<string, AssemblyElement>();
  const disciplines = new Map<string, AssemblyDiscipline>();
  const settings = new Map<string, AssemblySetting>();
  const tools: AssemblyTool[] = [];
  const declaredEvents: [string, AssemblyEvent][] = [];
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

    /*
      The `core.` namespace is AUTHORSHIP, and this is the one thing it buys: a manifest under
      it that the shipped distribution never registered is refused by name. The prefix confers
      no privilege at dispatch — that is the point of it — but an id is what a principal reads
      on the roster and what an agent reads over `GET /api/plugins`, so a stranger publishing
      `core.anything` would look official to both, and looking official is authority in the
      only place that matters here. Unknown distribution means unenforced rather than
      all-refused (`AssemblyEnv.distribution`).
    */
    if (
      distribution !== null &&
      manifest.id.startsWith(CORE_NAMESPACE_PREFIX) &&
      !distribution.has(manifest.id)
    ) {
      problems.push(
        `plugin "${manifest.id}" claims the reserved "${CORE_NAMESPACE_PREFIX}" namespace, which only the shipped distribution's own plugins may use`,
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
        // Always published, never inferred by the reader: the default is applied HERE so a
        // client answering "may my container-scoped token call this?" reads a value rather than an
        // absence it would have to know the rule for.
        scope: action.scope ?? "workspace",
        input: publishSchema(action.input, "input", `action "${name}" input`, problems),
        result: publishSchema(action.result, "output", `action "${name}" result`, problems),
      });
      actions.set(name, { plugin: manifest, def: action });
    }
    summaries.set(manifest.id, published);

    for (const panel of manifest.contributes.panels) {
      const id = panelRefId(manifest.id, panel.id);
      claim(panelIds, id, manifest.id);
      panels.set(id, { plugin: manifest.id, title: panel.title, arranges: panel.arranges });
    }
    /*
      SEAT LEGALITY. Composition does not BUILD the default tree — `composeDefaultLayout` does
      that from the published roster, so both halves compose from one implementation — but the
      two claims a composer could not check for itself are refused here, at build time, where a
      refusal names its offender instead of quietly seating the wrong thing.

      A seat's `panel` is checked against THIS manifest's own contributions rather than against
      the panel registry above: the registry is global and half-built at this point, so a lookup
      there would make legality depend on registration order AND would let a plugin seat
      somebody else's panel. A plugin seats only what it owns.

      The full id is CLAIMED for the same reason every other name here is: two seats for one
      panel would put that panel in two leaves of the default tree, and the arrange verbs find
      a panel's leaf by its ref — so a duplicate refuses with its offenders (D5).
    */
    for (const seat of manifest.contributes.seats ?? []) {
      if (!manifest.contributes.panels.some((panel) => panel.id === seat.panel)) {
        problems.push(
          `plugin "${manifest.id}" seats panel "${seat.panel}", which it does not contribute`,
        );
        continue;
      }
      claim(seatPanels, panelRefId(manifest.id, seat.panel), manifest.id);
    }
    /*
      SETTINGS are claimed under their FULL name, unlike a section and like a panel: a
      preference is a plugin's own vocabulary rather than a slot in something shared, so two
      plugins declaring `compact` is not a collision, and one plugin declaring it twice is.
      The claim is what makes a stored value unambiguous — one declaration answers one ref.
    */
    for (const setting of manifest.contributes.settings ?? []) {
      claim(settingRefs, settingRefId(manifest.id, setting.id), manifest.id);
      settings.set(settingRefId(manifest.id, setting.id), {
        plugin: manifest.id,
        declaration: setting,
      });
    }
    // Sections, elements and tools are named GLOBALLY rather than per plugin: a section is a
    // slot in one sidebar, an element type is a wire kind a scene doc stores, and a tool id is
    // what presence publishes as the peer's current tool. Two plugins claiming one of those
    // would be two plugins claiming one thing, which is exactly what D5 refuses.
    for (const section of manifest.contributes.sections) {
      claim(sectionIds, section.id, manifest.id);
      /*
        A GATED ROW IS CHECKED AGAINST ITS OWN MANIFEST, for the reason a seat's panel is: the
        settings registry above is global and half-built here, so a lookup there would make
        legality depend on registration order AND would let one plugin gate its row on
        somebody else's preference. The row still composes — a refused assembly names every
        problem it found rather than the first — and the ungated row is what a reader sees if
        this build somehow shipped.
      */
      if (
        section.setting !== undefined &&
        !(manifest.contributes.settings ?? []).some((setting) => setting.id === section.setting)
      ) {
        problems.push(
          `plugin "${manifest.id}" gates section "${section.id}" on setting "${section.setting}", which it does not contribute`,
        );
      }
      sections.push({
        id: section.id,
        plugin: manifest.id,
        title: section.title,
        order: section.order,
        // Spread rather than assigned: absent means "its own unit", and under
        // `exactOptionalPropertyTypes` an explicit `undefined` is a different statement.
        ...(section.cluster === undefined ? {} : { cluster: section.cluster }),
        // Spread for the same reason, and absent means "unconditional" (`visibleSections`).
        ...(section.setting === undefined ? {} : { setting: section.setting }),
        presentation: section.presentation ?? DEFAULT_SECTION_PRESENTATION,
      });
    }
    for (const element of manifest.contributes.elements) {
      claim(elementTypes, element.type, manifest.id);
      elements.set(element.type, {
        plugin: manifest.id,
        title: element.title,
        placement: element.placement ?? DEFAULT_ELEMENT_PLACEMENT_TRAITS,
        payload: def.elements?.[element.type] ?? null,
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
    /*
      CONTAINER DISCIPLINES (#110). A discipline id is claimed GLOBALLY for the same reason
      an element type is, and more sharply: it is the value stored in `containers.discipline`
      and the key a renderer is looked up by, so two plugins claiming one would make what a
      stored row MEANS depend on which of them composed last. The claim refuses with both
      names (D5).

      This registry is ALSO the replacement for the retired last-segment invariant
      (`layout.ts` records why it went): "which plugin renders this discipline?" is answered
      by the `plugin` field of the row below — data, claimed once and published — instead of
      by reading a spelling and hoping. That is what lets an UNINSTALLED discipline be
      legible rather than a crash: the roster says who declares each one, and a discipline
      with no row is exactly the case `unknown_discipline` names.

      Nothing here bounds a plugin to a single discipline, deliberately. The old pun
      implied that bound and never enforced it; a plugin that genuinely renders two related
      disciplines composes as long as it claims two names nobody else claims.
    */
    for (const discipline of manifest.contributes.disciplines ?? []) {
      claim(disciplineIds, discipline.id, manifest.id);
      disciplines.set(discipline.id, { plugin: manifest.id, declaration: discipline });
    }
    for (const tool of manifest.contributes.tools) {
      claim(toolIds, tool.id, manifest.id);
      tools.push({ id: tool.id, plugin: manifest.id, title: tool.title });
    }
    // A ROUTE SEGMENT is claimed GLOBALLY too, and for the plainest reason of the lot: there
    // is ONE URL space, so `/uri/` is one plugin's or nobody's. The browser resolves a path
    // by looking its first segment up in this vocabulary, which is why the claim has to be
    // refused HERE rather than settled by whichever web half registered last.
    for (const route of manifest.contributes.routes ?? []) {
      claim(routeSegments, route.segment, manifest.id);
    }
    // THE EVENT PLANE's vocabulary (ADR 0012). An event kind is claimed GLOBALLY, exactly as a
    // section slot and an element type are: `terminal_exited` names one concept, and a second
    // plugin claiming it would make a subscriber's match depend on which of the two emitted.
    // Indexed as well as claimed, because the index is what makes emission checkable at all —
    // an emission whose kind nobody declared is refused rather than fanned out.
    for (const event of manifest.contributes.events) {
      claim(eventIds, event.id, manifest.id);
      declaredEvents.push([event.id, { plugin: manifest.id, title: event.title }]);
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
  reportDuplicates(disciplineIds, "discipline", problems);
  reportDuplicates(settingRefs, "setting", problems);
  reportDuplicates(toolIds, "tool", problems);
  reportDuplicates(eventIds, "event", problems);
  reportDuplicates(seatPanels, "seat", problems);
  reportDuplicates(routeSegments, "route", problems);

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

  if (problems.length > 0) throw new AssemblyError(problems);

  sections.sort((left, right) => left.order - right.order);
  // Sorted, not registration-ordered: this index is published vocabulary, and a diff of two
  // builds' event surfaces should show what changed rather than where a registration moved.
  declaredEvents.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

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
    disciplines,
    settings,
    tools,
    events: new Map(declaredEvents),
    order,
    pendingMigrations,
    enabled: isEnabled,
    builtin: (id) => builtins.has(id),
    requiredBy,
    unmet,
    conflicts,
  };
}
