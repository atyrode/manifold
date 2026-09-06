import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { EventKindSchema } from "./events.ts";
import { ContainerDisciplineSchema } from "./layout.ts";
import {
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  DisciplineDefSchema,
  PlacementTraitsSchema,
  type DisciplineDeclaration,
} from "./placement.ts";

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
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}$/;
export const PluginIdSchema = z.string().regex(PLUGIN_ID_PATTERN).max(64);
export type PluginId = z.infer<typeof PluginIdSchema>;

/**
 * The namespace reserved for the ENGINE's own doors. Enablement itself is a door — the
 * thing that turns plugins on cannot be a plugin that can be turned off — so it is
 * published as an ordinary roster row under `engine.plugins`, with the same manifest and
 * the same action schemas as everything else, distinguished only by `source: "builtin"`.
 * One dispatch ladder, one vocabulary, no privileged second door.
 *
 * The prefix is a RESERVATION: assembly refuses a non-builtin plugin claiming an id
 * under it, because a plugin that could publish `engine.*` could impersonate the engine to
 * a client reading the roster.
 */
export const ENGINE_NAMESPACE_PREFIX = "engine.";

/**
 * The namespace manifold's own shipped plugins are authored under, and NOTHING ELSE. It
 * confers no privilege whatsoever: a `core.` row is dispatched, authorized, disabled and
 * purged by exactly the rules a stranger's row is, and the engine has no branch anywhere that
 * reads this prefix to decide what something may do. That is the point of publishing it —
 * "core is not privileged" is checkable when the prefix means AUTHORSHIP and nothing more.
 *
 * Authorship is still worth defending, so the prefix is also a RESERVATION, symmetric with
 * `ENGINE_NAMESPACE_PREFIX`: assembly refuses a manifest under `core.` that the shipped
 * distribution did not register, because a stranger's plugin publishing `core.anything`
 * composes cleanly and reads as official to every principal and agent looking at the roster.
 * The permitted set is DERIVED from the distribution's own registration files and handed to
 * `assembleRoster` (`AssemblyEnv.distribution`), never written out a second time here — a
 * hand-kept list of "our" plugins in this package is exactly the second door invariant 14
 * forbids, and it would be the thing that goes stale the first time a plugin is added.
 */
export const CORE_NAMESPACE_PREFIX = "core.";

/**
 * A contribution's name INSIDE its plugin. Every published name is the pair — an action is
 * `${manifest.id}.${local}` on the wire — so a plugin can never name anything outside its
 * own namespace and a full name always says who owns it.
 *
 * Exported because the assembly engine validates every action's local name against this
 * exact rule before it builds a full name: one door per concept, so a local name is legal
 * here and there or nowhere.
 *
 * Interior capitals are allowed because the ratified vocabulary uses them where the name is
 * a verb phrase (`engine.plugins.setEnabled`); a name still starts lowercase and carries no
 * dot, so the segment boundary in a full name stays unambiguous.
 */
export const LOCAL_NAME_PATTERN = /^[a-z][a-zA-Z0-9-]*$/;
export const LocalNameSchema = z.string().regex(LOCAL_NAME_PATTERN).max(32);
export type LocalName = z.infer<typeof LocalNameSchema>;

const TitleSchema = z.string().min(1).max(64);

/**
 * HOW a contributed sidebar row draws itself. `disclosure` is the titled, collapsible block
 * the stack has always been; `plain` is a row that draws its own content end to end — no
 * disclosure header, no collapse.
 *
 * The second member exists for NEUTRALITY, not for looks. A sidebar whose only contributable
 * shape is a collapsible block forces everything that is not one — the create buttons, the
 * brand line, the status line, the identity row — to stay hand-written floor JSX, and then
 * the shell is honest about ownership for the blocks and silent about the rest. With `plain`
 * those rows are ordinary contributions: one registry, one per-principal order, two
 * presentations. `presentation` says how a row draws and never whether it is one, which is
 * why arrange mode, the owner-naming DOM and the D4′ placeholder all stay indifferent to it.
 *
 * Absent ≡ {@link DEFAULT_SECTION_PRESENTATION} — every manifest written before this field
 * existed composes, orders and renders exactly as it did.
 */
export const SECTION_PRESENTATIONS = ["disclosure", "plain"] as const;
export const SectionPresentationSchema = z.enum(SECTION_PRESENTATIONS);
export type SectionPresentation = (typeof SECTION_PRESENTATIONS)[number];
export const DEFAULT_SECTION_PRESENTATION: SectionPresentation = "disclosure";

/** Closed value kinds and storage scopes published with the manifest vocabulary. */
export const SETTING_KINDS = ["boolean", "enum"] as const;
export const SETTING_SCOPES = ["principal", "workspace"] as const;
export const SettingScopeSchema = z.enum(SETTING_SCOPES);
export const SettingValueSchema = z.union([z.boolean(), z.string().min(1).max(128)]);
export type SettingValue = z.infer<typeof SettingValueSchema>;
export const SettingKindSchema = z.enum(SETTING_KINDS);
export type SettingKind = (typeof SETTING_KINDS)[number];

/**
 * ONE SETTING A PLUGIN DECLARES: a named preference a principal may hold an opinion about,
 * published at `GET /api/plugins` with everything else the manifest contributes.
 *
 * DECLARATION IS THE WHOLE VOCABULARY, which is what makes the manager's pane generic: the
 * engine renders a control per declared row and knows nothing about what any of them mean, so
 * a stranger's plugin gets the same pane `core.canvas` does without registering a component,
 * and a plugin that declares none is a NAMED absence rather than an empty box. A setting whose
 * effect nobody declared is impossible to store, because a write names a declaration
 * (`engine.plugins.setSetting`) and an undeclared name is refused.
 *
 * `default` is what the setting reads as when this principal has expressed no opinion —
 * carried in the MANIFEST rather than in the store, so a value nobody has ever written is a
 * fact about the plugin's shipped behaviour and the empty override map is the whole of
 * "nothing customized" (the same delta discipline {@link BindingOverridesSchema} keeps).
 *
 * The id is LOCAL; the published name is the pair, `${manifest.id}.${id}`
 * ({@link SettingRefSchema}), so a plugin can never declare a preference outside its own
 * namespace and a stored value always says whose declaration it answers.
 */
const settingFields = {
  id: LocalNameSchema,
  title: TitleSchema,
  scope: SettingScopeSchema.optional(),
};
export const SettingDefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...settingFields, kind: z.literal("boolean"), default: z.boolean() }),
  z
    .strictObject({
      ...settingFields,
      kind: z.literal("enum"),
      values: z
        .array(z.strictObject({ id: z.string().min(1).max(128), title: TitleSchema }))
        .min(1)
        .max(32),
      default: z.string().min(1).max(128),
    })
    .superRefine((setting, ctx) => {
      if (new Set(setting.values.map((value) => value.id)).size !== setting.values.length)
        ctx.addIssue({ code: "custom", message: "invalid_setting_enum: duplicate values" });
      if (!setting.values.some((value) => value.id === setting.default))
        ctx.addIssue({
          code: "custom",
          message: "invalid_setting_enum: default is outside values",
        });
    }),
]);
export type SettingDef = z.infer<typeof SettingDefSchema>;

/**
 * One contributed sidebar row. `title` is REQUIRED of both presentations: arrange mode labels
 * the row a reader has grabbed, and a disabled plugin's slot is named by the ENGINE's own
 * placeholder (D4′) — neither may ask a row's component for a name, least of all a plain row
 * whose code may not be loaded.
 *
 * `cluster` is the row saying "I BELONG BESIDE WHOEVER ELSE DECLARES THIS WORD". Rows sharing a
 * cluster render as ONE horizontal row, placed where the cluster's earliest member sits in the
 * live order — so two discreet rows can sit side by side at the rail's foot without the rail
 * knowing which rows those are. The mechanism is deliberately total and dumb: the word is the
 * whole vocabulary, membership is declared rather than positional, and no floor file, panel or
 * engine registry holds a list of a cluster's members (`clusteredSections`,
 * `packages/plugin/src/layout.ts`). That is what makes it survive a plugin being disabled,
 * added or rearranged, and what keeps `core.keys` and `core.plugins` from being named anywhere
 * but in their own manifests (issue #91).
 *
 * NOT `group`: that word is taken, by the placement algebra's capability sets (§Lexicon), and
 * one concept per word is the law. `cluster` is this concept's canon term — a declared set of
 * sidebar rows painted side by side — and the `Cluster` box from `@manifold/plugin/ui` is what
 * happens to paint one, the same way the `layout` family's components are named for the shape
 * they draw without touching the canon term.
 *
 * A cluster is not a second order and not a container: the members keep their own ids, their
 * own arrangement seats and their own owners, and a cluster with one live member paints exactly
 * as that member always did.
 *
 * Absent ≡ this row is its own cluster, which is what every manifest written before the field
 * existed says, and why a rail of unclustered rows is byte-identical to today's.
 *
 * `setting` is the row saying "I AM A PREFERENCE, AND THIS DECLARATION HOLDS IT": one of this
 * manifest's OWN `contributes.settings` ids, resolved at composition, and a row whose setting
 * reads false is DROPPED from the sidebar entirely (`visibleSections`,
 * `packages/plugin/src/settings.ts`). Dropped, not marked: a preference is not a disable, so
 * there is no tombstone, no placeholder and no seat kept warm — the difference from D4′ is the
 * whole point, because a disabled plugin's row is an absence the workspace must explain and a
 * row somebody turned off is one they already know about.
 *
 * The reference is LOCAL and stays local: a section may only name a setting its own manifest
 * declares, and assembly refuses one that names anything else with both names in the sentence.
 * A cross-plugin reference would let one plugin's preference erase another's row, which is the
 * shadowing D5 refuses one level up.
 *
 * Absent ≡ this row is unconditional, which is what every manifest written before the field
 * existed says.
 */
export const SectionDefSchema = z.strictObject({
  id: LocalNameSchema,
  title: TitleSchema,
  order: z.number().int(),
  presentation: SectionPresentationSchema.optional(),
  cluster: LocalNameSchema.optional(),
  setting: LocalNameSchema.optional(),
});
export type SectionDef = z.infer<typeof SectionDefSchema>;

/**
 * ONE CONTRIBUTED PANEL: a tile-ref leaf, named `${manifest.id}.${id}` in a `panel` ref.
 *
 * `arranges` is the panel saying "I CONTAIN AN INNER ARRANGEMENT, AND THIS IS ITS NAME". A
 * workspace's arrange mode (`vantage.arranging`) makes panels grabbable inside the tree; a
 * panel that stacks parts of its own — the shell's sidebar and its rows are the first, and
 * deliberately not the only conceivable one — can offer a SECOND scope to arrange inside,
 * and the chrome that offers it needs a word for the thing it is about to zoom into.
 *
 * The declaration is the whole vocabulary, which is the point: the floor renders a zoom-in
 * control for panels that declare one and knows nothing else about what is in there — no
 * enumerated list of arrangeable panels, no "sidebar" anywhere in the engine. What the inner
 * arrangement CONTAINS, how it reorders and where it commits stay entirely the panel's; this
 * says only that it exists and what to call it.
 *
 * Absent ≡ the panel arranges nothing inside itself, which is what every manifest written
 * before this field existed says.
 */
export const PanelDefSchema = z.strictObject({
  id: LocalNameSchema,
  title: TitleSchema,
  arranges: z.strictObject({ title: TitleSchema }).optional(),
});
export type PanelDef = z.infer<typeof PanelDefSchema>;

/**
 * The weight a seat's leaf carries in its split when the manifest declares none. Ratios are
 * RELATIVE: the tile renderer normalizes a split's `ratios` before it paints (flex-grow on a
 * zero basis), so a declaration is a weight against its siblings rather than a promised
 * fraction of a screen nobody has measured yet.
 */
export const DEFAULT_SEAT_RATIO = 1;

/**
 * ONE SEAT A PLUGIN ASKS FOR in a workspace nobody has arranged yet (ADR 0017 §3, stage
 * S17-B): `panel` is one of this manifest's OWN contributed panels, `order` places the seat
 * among every other plugin's, and `ratio` weights its leaf against its siblings.
 *
 * An INTENT, not an arrangement. The engine composes the default workspace tree out of the
 * ENABLED roster's seats, so a first-boot tree is a function of which plugins are on rather
 * than of a constant some floor file kept beside a favourite pair of panel names. A principal
 * who has arranged a workspace is untouched by it: their tree is stored, and this composes
 * only the default for the ones who never did.
 *
 * DUMB AND TOTAL on purpose. A seat names a panel and a place in one row; it cannot express
 * nesting, and it deliberately carries no address — seats holding a `manifold://` referent are
 * stage S17-C and a version-bumped protocol change (ADR 0017 R3), which this field must not
 * pre-empt by shipping half of that wire early.
 *
 * Absent ≡ the plugin seats nothing, which is exactly what every manifest written before this
 * field existed says, and why one manifest line is the whole cost of keeping today's tree.
 */
export const SeatDefSchema = z.strictObject({
  panel: LocalNameSchema,
  order: z.number().int(),
  ratio: z.number().positive().optional(),
});
export type SeatDef = z.infer<typeof SeatDefSchema>;

/**
 * WHICH TOOLBAR a contributed tool paints into. The engine owns the closed vocabulary of
 * toolbars that exist; plugins own the tools inside one, so two plugins contributing `select`
 * into different toolbars is not a collision (D5 still refuses two plugins claiming the same
 * `id` WITHIN one toolbar).
 *
 * `canvas` is the freeform discipline's tool strip (`core.canvas`'s own two modes, `core.draw`'s
 * pen — {@link CanvasToolbar}). `arrange` is `core.arrange`'s floating F8 editor toolbar
 * (issue #89) — a workspace-level toolbar, unrelated to any one container.
 *
 * Absent ≡ `canvas`, which is what every `tools` row written before this field existed means:
 * the only toolbar the product had. A tool naming a toolbar the reading strip does not draw
 * from is simply invisible there — the same "declare and let the ref filter" shape `arranges`,
 * `cluster` and every other closed-vocabulary field in this file already uses.
 */
export const TOOLBARS = ["canvas", "arrange"] as const;
export const ToolbarSchema = z.enum(TOOLBARS);
export type Toolbar = (typeof TOOLBARS)[number];
export const DEFAULT_TOOLBAR: Toolbar = "canvas";

/**
 * A BROWSER PATH SEGMENT, as a claim: lowercase, digits and dashes, which is exactly the
 * shape the browser's own router matches (`PLUGIN_ROUTE`, `packages/web/src/app.tsx`, which
 * tests captured segments against this pattern rather than spelling the class a second time).
 * A segment carries no slash, so `/uri/<rest>` splits unambiguously into the claim and the
 * rest nobody but the claimant reads.
 */
export const ROUTE_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
export const RouteSegmentSchema = z.string().regex(ROUTE_SEGMENT_PATTERN).max(32);

/**
 * ONE CONTRIBUTED ROUTE: the URL space a plugin owns, named by its first path segment
 * (`core.uri` claims `uri` and serves `/uri/<rest>`).
 *
 * The manifest counterpart the web channel went without: a route was a registration-time
 * convention, so the roster could not publish the paths a build answers on and two plugins
 * claiming one segment shadowed each other by registration order. Declaring it makes the
 * claim DATA — published at `GET /api/plugins`, refused with both offenders named when two
 * manifests want one segment (D5), and the reason a registration for an undeclared segment
 * contributes nothing, exactly as a smuggled panel does.
 *
 * A segment is claimed GLOBALLY, unlike a panel: there is one URL space, and `/uri/` means
 * one plugin's route or nobody's.
 *
 * Absent ≡ this plugin claims no path, which is what every manifest written before the field
 * existed says.
 */
export const RouteDefSchema = z.strictObject({
  segment: RouteSegmentSchema,
  title: TitleSchema,
});
export type RouteDef = z.infer<typeof RouteDefSchema>;

/**
 * What a plugin declares it adds to the assembly. Each list is bounded, because a
 * manifest is read on every roster fan-out and a plugin contributing hundreds of anything
 * is a plugin that should be several.
 *
 * `panels` are tile-ref leaves (the workspace shell is itself a composition of them, and one
 * may declare an inner arrangement of its own — see {@link PanelDefSchema}), `seats`
 * are where those panels ask to sit in a workspace nobody has arranged (see
 * {@link SeatDefSchema}), `sections` are sidebar rows ordered by their declared `order` (see
 * {@link SectionDefSchema}), `elements` are canvas element renderers keyed by wire type,
 * `tools` are toolbar tools, and `routes` are the URL spaces it claims (see
 * {@link RouteDefSchema}).
 */
const ContributesSchema = z.strictObject({
  panels: z.array(PanelDefSchema).max(8).default([]),
  /**
   * WHERE THIS PLUGIN'S PANELS ASK TO SIT in the default workspace ({@link SeatDefSchema}).
   * Optional rather than defaulted to `[]`: absence is a MEANING here — the plugin seats
   * nothing — so every manifest written before the field existed keeps exactly the sense it
   * had, and a build's default tree stays the sum of what its roster asked for.
   */
  seats: z.array(SeatDefSchema).max(8).optional(),
  sections: z.array(SectionDefSchema).max(8).default([]),
  /**
   * A contributed element kind: `type` is the wire type stored in scene documents, and
   * `placement` is how the algebra must treat it (G1). Traits are DATA here for the same
   * reason they are data in `ITEM_KINDS` — legality follows from the declaration.
   * Absent placement ≡ `DEFAULT_ELEMENT_PLACEMENT_TRAITS`: free-floating canvas furniture.
   * `presentation` declares body-only or titled framing per container discipline. Absence
   * stays absent in the registry; a mount site defaults an undeclared discipline to titlebar.
   */
  elements: z
    .array(
      z.strictObject({
        type: z.string().min(1).max(32),
        title: TitleSchema,
        placement: PlacementTraitsSchema.optional(),
        presentation: z
          .record(ContainerDisciplineSchema, z.enum(["body", "titlebar"]))
          .refine((values) => Object.keys(values).length <= 32, {
            message: "at most 32 element presentation disciplines",
          })
          .optional(),
      }),
    )
    .max(8)
    .default([]),
  /**
   * THE CONTAINER DISCIPLINES THIS PLUGIN RENDERS (#110, building the ruling ratified on
   * #86). A discipline is the value of `Container.discipline` and the key
   * `ProjectionRegistry.renderer` is looked up by, and declaring it carries the placement
   * rows `packages/protocol/src/placement.ts` used to hold as literals for the two
   * disciplines that happened to ship in the box (see {@link DisciplineDefSchema}).
   *
   * Optional rather than defaulted to `[]` for the reason `seats` and `routes` are:
   * absence is a MEANING — this plugin renders no container of its own — so every manifest
   * written before the field existed keeps exactly the sense it had, and the composed
   * roster stays the sum of what its members declared.
   *
   * `max(4)` bounds the payload the way every other list here is bounded, and nothing
   * bounds it lower: the last-segment pun that used to imply one discipline per plugin was
   * never true (`core.compositions` renders `composition`) and is retired on the record in
   * `layout.ts`. What a declaration must actually survive is the global claim — a
   * discipline id is one plugin's or nobody's, and two declarants refuse by name.
   */
  disciplines: z.array(DisciplineDefSchema).max(4).optional(),
  tools: z
    .array(
      z.strictObject({
        id: LocalNameSchema,
        title: TitleSchema,
        toolbar: ToolbarSchema.optional(),
      }),
    )
    .max(8)
    .default([]),
  /**
   * THE EVENT PLANE's vocabulary half (ADR 0012): the kinds this plugin ORIGINATES. Declaring
   * one claims the word globally — assembly refuses a second claimant (D5) — and it is the
   * only way an emission is legal: the engine emits at its doors, and an emission whose kind
   * this list does not hold is refused by name rather than fanned out. So the mechanism is
   * closed while the vocabulary stays open, which is the whole shape of the plane.
   *
   * `id` is an {@link EventKindSchema}, not a `LocalNameSchema`: a kind is snake_case because
   * the durable history and `terminal_event.kind` already spell it that way, and one concept
   * gets one spelling on every plane.
   */
  events: z
    .array(z.strictObject({ id: EventKindSchema, title: TitleSchema }))
    .max(16)
    .default([]),
  /**
   * THE URL SPACES THIS PLUGIN CLAIMS ({@link RouteDefSchema}). Optional rather than
   * defaulted to `[]` for the reason `seats` is: absence is a MEANING — this plugin answers
   * on no path of its own — so every manifest written before the field existed keeps exactly
   * the sense it had, and the browser's route table stays the sum of what the roster claimed.
   */
  routes: z.array(RouteDefSchema).max(8).optional(),
  /**
   * THE PREFERENCES THIS PLUGIN DECLARES ({@link SettingDefSchema}). Optional rather than
   * defaulted to `[]` for the reason `seats` and `routes` are, and here the absence carries
   * one more consequence worth naming: a plugin that declares nothing serializes byte-for-byte
   * as it did before this field existed, so adding the vocabulary moved no wire and the
   * manager's pane for such a plugin is a named absence rather than an empty form.
   */
  settings: z.array(SettingDefSchema).max(8).optional(),
});

/**
 * What one plugin needs of another. Requirement and ORDER are separate axes: `required`
 * refuses assembly when the named plugin is missing or disabled, `incompatible` refuses
 * when it is present, `optional` refuses nothing and exists so a client can explain a
 * degraded experience. Ordering is declared separately (`after`), because "I need X" and "put
 * me after X" are different sentences and conflating them forces authors to invent a
 * dependency to get a sequence.
 *
 * `reason` is user-facing text: a dependency failure is read by a human deciding what to
 * turn on, and demanding the sentence at authoring time costs nothing.
 */
export const PLUGIN_DEPENDENCY_TYPES = ["required", "optional", "incompatible"] as const;
export type PluginDependencyType = (typeof PLUGIN_DEPENDENCY_TYPES)[number];
export const PluginDependencySchema = z.strictObject({
  type: z.enum(PLUGIN_DEPENDENCY_TYPES),
  reason: z.string().min(1).max(200).optional(),
});
export type PluginDependency = z.infer<typeof PluginDependencySchema>;

/**
 * The declarations, keyed BY the plugin depended on. A map rather than a list because a
 * manifest naming the same plugin twice is not a thing to refuse at compose time — it is a
 * thing the shape should make unsayable — and because a reader asking "what does this say
 * about `core.shell`?" indexes instead of scanning.
 */
export const PluginDependencyMapSchema = z.record(PluginIdSchema, PluginDependencySchema);
export type PluginDependencyMap = z.infer<typeof PluginDependencyMapSchema>;

/**
 * The version of the DATA a plugin owns, which is not the version of its code: a plugin
 * ships many releases against one storage shape. The split is what makes the compatibility
 * rule statable — minor differences proceed untouched, a major difference is a migration
 * the plugin must name, and stored-newer-than-code is refused rather than guessed at.
 */
export const PluginDataVersionSchema = z.strictObject({
  major: z.number().int().min(0),
  minor: z.number().int().min(0),
});
export type PluginDataVersion = z.infer<typeof PluginDataVersionSchema>;

/**
 * How this plugin's already-placed nodes render while it is disabled. DECLARATIVE on
 * purpose: the placeholder is drawn by the ENGINE from this data, never by a component the
 * disabled plugin supplies — the plugin whose code may not be loaded cannot be the one
 * asked to draw its own absence.
 *
 * `ghost` keeps the node visible, named and inert (the default, and the only honest answer
 * for something holding a user's work); `hide` skips it at paint while leaving it in the
 * document, for chrome whose absence is not a loss. `label` overrides the name the ghost
 * shows. Absent ≡ `{ mode: DEFAULT_DORMANT_MODE }`.
 */
export const PLUGIN_DORMANT_MODES = ["ghost", "hide"] as const;
export type PluginDormantMode = (typeof PLUGIN_DORMANT_MODES)[number];
export const DEFAULT_DORMANT_MODE: PluginDormantMode = "ghost";
export const PluginDormantSchema = z.strictObject({
  mode: z.enum(PLUGIN_DORMANT_MODES),
  label: z.string().min(1).max(64).optional(),
});
export type PluginDormant = z.infer<typeof PluginDormantSchema>;

/**
 * Every way something of a DISABLED plugin may still be live — the complete list, closed.
 * A disable gates a plugin's active contributions; these three are the declared carve-outs that
 * survive it, one per plane:
 *
 *   `cleanup`  an action stays dispatchable while disabled (D12), so nobody is ever locked
 *              out of removing a thing the plugin created.
 *   `dormant`  the render plane: placed nodes stay in the document and paint as declared.
 *   `retain`   the data plane, and the ONLY data fate a disable has. Disable is reversible
 *              in every system worth copying; destruction is a separate, separately-gated
 *              verb (see `PLUGIN_PURGE_TARGETS`) that refuses while the plugin is enabled.
 *
 * The list is closed so the carve-out cannot grow quietly: a fourth residual mechanism is
 * a protocol change reviewed as one.
 */
export const PLUGIN_RESIDUAL_MECHANISMS = ["cleanup", "dormant", "retain"] as const;
export type PluginResidualMechanism = (typeof PLUGIN_RESIDUAL_MECHANISMS)[number];

/**
 * What a PURGE destroys. Purge is the deliberate opposite of disable: it is refused while
 * the plugin is enabled, it names what it will remove before it removes it, and a manifest
 * declares its targets so the loss is auditable from data rather than discovered from a
 * hook's behavior.
 *
 *   `storage`   the plugin's namespaced rows.
 *   `elements`  scene elements of the kinds it owns.
 *   `ownership` its element-type reservation — after this, another plugin may claim those
 *               kinds. Until it, the reservation stands precisely so a disabled plugin's
 *               stored data can never be inherited by a stranger.
 */
export const PLUGIN_PURGE_TARGETS = ["storage", "elements", "ownership"] as const;
export const PluginPurgeTargetSchema = z.enum(PLUGIN_PURGE_TARGETS);
export type PluginPurgeTarget = (typeof PLUGIN_PURGE_TARGETS)[number];

/**
 * What a purge REMOVED, per target — every target accounted for, zeros included, because
 * "nothing was there" and "that target was skipped" must not read the same to the caller
 * who just authorised a deletion.
 */
export const PluginPurgeResultSchema = z.strictObject({
  id: PluginIdSchema,
  removed: z.record(PluginPurgeTargetSchema, z.number().int().min(0)),
});
export type PluginPurgeResult = z.infer<typeof PluginPurgeResultSchema>;

/**
 * WHERE AN ISOLATED PLUGIN'S CODE IS, inside its bundle. `server: true` means the bundle's
 * `server.js` member is the server guest (the file name is fixed — `PLUGIN_BUNDLE_SERVER_FILE`
 * — because the kit inlines its runtime and the loader is one `Bun.spawn`); `web` names the
 * member the browser fetches at `GET /api/plugins/:id/web.js` and runs in a dedicated Worker.
 * Either half alone is a plugin; a bundle naming neither is refused `no_entry`.
 */
export const PluginEntrySchema = z.strictObject({
  web: z.string().min(1).max(128).optional(),
  server: z.boolean().optional(),
});
export type PluginEntry = z.infer<typeof PluginEntrySchema>;

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
   *
   * The refusal it raises is the `essential` member of `PLUGIN_REFUSAL_REASONS` — a CLASS,
   * not a sentence, and one of several: a system with a single reason to refuse a disable
   * grows its second one immediately (a required dependency, an owned element type), and
   * clients that switched on prose would have to be rewritten each time.
   */
  essential: z.boolean().optional(),
  contributes: ContributesSchema,
  /**
   * Declared relationships. Absent ≡ none, which is every manifest written before this
   * field existed: a plugin naming nothing composes exactly as it did.
   */
  dependencies: PluginDependencyMapSchema.optional(),
  /**
   * SOFT ordering: compose me after these, if they are here at all. A missing id in this
   * list is not an error — that is the whole difference from a dependency — and the
   * resulting order (topological, ties by lexicographic id) is the order lifecycle hooks
   * fan out in, so "after" is a statement about sequence and nothing else.
   */
  after: PluginIdSchema.array().max(16).optional(),
  /** Absent ≡ unversioned data: nothing to migrate, nothing to refuse. */
  dataVersion: PluginDataVersionSchema.optional(),
  /** Absent ≡ `{ mode: DEFAULT_DORMANT_MODE }` — a named, inert ghost. */
  dormant: PluginDormantSchema.optional(),
  /**
   * What a purge of this plugin would destroy, declared for audit visibility. It is a
   * DESCRIPTION, never a trigger: nothing here is bound to the disable verb.
   */
  purges: PluginPurgeTargetSchema.array().max(PLUGIN_PURGE_TARGETS.length).optional(),
  /**
   * Which halves an INSTALLED bundle runs, and where (ADR 0016 §8 stage 2). Absent for every
   * in-tree manifest: a package compiled into the build is found by the two `assembly.ts`
   * files, not by this field. `PluginBundleSchema` requires it.
   */
  entry: PluginEntrySchema.optional(),
  /**
   * Where this plugin comes from, for a reader who wants to look: the repository its code
   * lives in (the manager shows it), a homepage, and a changelog — which the update flow
   * (#238) reads to say what a newer version changes. Absent ≡ the author said nothing, which
   * is every in-tree manifest.
   */
  links: z
    .strictObject({
      repository: z.string().url().max(512).optional(),
      homepage: z.string().url().max(512).optional(),
      changelog: z.string().url().max(512).optional(),
    })
    .optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * WHAT AUTHORITY AN ACTION IS GRADED FOR.
 *
 * `workspace` is the default and the wave-1 rule: a token scoped to one container cannot
 * authorize a workspace-grade mutation, the precedent `core.space.place` and every
 * workspace route already set.
 *
 * `container` says the action's whole effect is confined to ONE container, so a
 * container-scoped token may open it — the door then evaluates the action's declared caps
 * AT that container, and the handler is contractually bound to keep every effect inside
 * it. The container comes from the TOKEN (`ctx.containerScope`), never from the arguments:
 * authority that depended on parsed arguments would force the ladder to validate shape
 * before authority, and a caller would learn an action's schema by knocking on a door it
 * may not open.
 *
 * A workspace-grade caller invoking a `container` action gets `containerScope: null` and
 * the handler resolves its target the way it always did.
 */
export const ACTION_SCOPES = ["workspace", "container"] as const;
export const ActionScopeSchema = z.enum(ACTION_SCOPES);
export type ActionScope = (typeof ACTION_SCOPES)[number];

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
  /**
   * The authority grade this door is written for. Published (defaulted, so an older reader
   * that never saw the field reads the conservative answer) because "may my container-scoped
   * token call this?" is a question a client must be able to answer from the vocabulary alone.
   */
  scope: ActionScopeSchema.default("workspace"),
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});
export type ActionSummary = z.infer<typeof ActionSummarySchema>;

/**
 * Where a roster row's code came from. `builtin` is the ENGINE's own doors (enablement,
 * purge): same manifest, same action schemas, same dispatch ladder, but no toggle — the
 * mechanism that turns plugins on is not itself a plugin. `plugin` is everything else,
 * including every core plugin, which is what makes "core is not privileged" checkable
 * rather than merely claimed. A distributed plugin will be `plugin` too, so the marketplace
 * wave needs no new roster shape.
 */
export const PLUGIN_SOURCES = ["builtin", "plugin"] as const;
export const PluginSourceSchema = z.enum(PLUGIN_SOURCES);
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/**
 * What the last lifecycle transition DID, when it did not simply work. A hot toggle runs
 * trusted in-process teardown, and teardown of arbitrary code is unreliable — so failure
 * is a representable state rather than an assertion: the disable ALWAYS completes (a
 * shared workspace is never wedged on one plugin's cleanup) and the roster says so, to
 * every connected principal at once. Absent ≡ `ok`.
 *
 * The two `isolate_` states are what a RUNNER can be in (ADR 0016 §6): an installed row's
 * child is being spawned (`isolate_starting`), or it crashed past `ISOLATE_CRASH_BUDGET` and
 * the supervisor stopped respawning it (`isolate_crashed`) — a degraded row every principal
 * sees, rather than a log line somebody greps. Only rows carrying `install` ever hold them.
 */
export const PLUGIN_LIFECYCLE_STATES = [
  "ok",
  "enable_failed",
  "disable_failed",
  "isolate_starting",
  "isolate_crashed",
] as const;
export const PluginLifecycleStateSchema = z.enum(PLUGIN_LIFECYCLE_STATES);
export type PluginLifecycleState = (typeof PLUGIN_LIFECYCLE_STATES)[number];

/**
 * The named classes of refusal a plugin can meet. A refusal is a CLASS, never a sentence:
 * clients switch on it, agents branch on it, and prose stays a courtesy. `essential` was
 * the first one and is why this is a list — a system with one reason to refuse grows a
 * second immediately.
 *
 *   `essential`               the workspace cannot render itself without it.
 *   `builtin`                 an engine door has no toggle to flip.
 *   `unknown_plugin`          well-formed id, no such row.
 *   `missing_dependency`      a `required` dependency is not composed.
 *   `incompatible_dependency` an `incompatible` dependency IS composed.
 *   `dependency_disabled`     a `required` dependency is present but off; re-enable it
 *                             first, rather than run this plugin against a missing peer.
 *   `data_downgrade`          stored data is newer than the code that would read it.
 *   `data_migration_missing`  a major data version differs and no migration names the gap.
 *   `element_type_owned`      another plugin — possibly a disabled one — owns that element
 *                             type. A reservation outlives a disable so stored nodes can
 *                             never be inherited by a stranger.
 *   `still_enabled`           a purge was asked of a plugin that is still on.
 *
 * A row carries at most one, and the roster carries every row, so a client renders "why"
 * without a second call: which dependency is off is read from this row's manifest against
 * the other rows' `enabled`.
 */
export const PLUGIN_REFUSAL_REASONS = [
  "essential",
  "builtin",
  "unknown_plugin",
  "missing_dependency",
  "incompatible_dependency",
  "dependency_disabled",
  "data_downgrade",
  "data_migration_missing",
  "element_type_owned",
  "still_enabled",
] as const;
export const PluginRefusalReasonSchema = z.enum(PLUGIN_REFUSAL_REASONS);
export type PluginRefusalReason = (typeof PLUGIN_REFUSAL_REASONS)[number];

/**
 * Why an INSTALL or UNINSTALL was refused (ADR 0016 §8 stage 2), the same discipline as the
 * toggle refusals above: a class a client switches on, with the detail after a colon.
 *
 *   `artifact_unreadable`  the source could not be fetched or read at all.
 *   `artifact_invalid`     the bytes are not a bundle this engine reads — wrong format, a
 *                          manifest that fails the schema, or an assembly refusal (a duplicate
 *                          id, a `core.` squat) caught at install time rather than at boot.
 *   `hash_mismatch`        the bytes hash to something other than the `sha256` the installer
 *                          pinned — refused fail-closed, at install and again at every boot (R8).
 *   `already_installed`    that id is installed at a different hash and `replace` was not asked.
 *   `not_installed`        an uninstall or replace of an id nobody installed.
 *   `namespace_reserved`   the manifest claims `engine.` or `core.`, which only the build may.
 *   `still_enabled`        an uninstall or replace of a plugin that is still on: disable first.
 *   `storage_retained`     an uninstall of a plugin whose storage still holds rows (#233): purge
 *                          first, or pass `purge: true` and the door purges before it uninstalls.
 *                          Uninstall never destroys data on its own, and it never strands any.
 *   `no_entry`             the manifest names no half to run — nothing to install.
 */
export const PLUGIN_INSTALL_REFUSALS = [
  "artifact_unreadable",
  "artifact_invalid",
  "hash_mismatch",
  "already_installed",
  "not_installed",
  "namespace_reserved",
  "still_enabled",
  "storage_retained",
  "no_entry",
] as const;
export const PluginInstallRefusalSchema = z.enum(PLUGIN_INSTALL_REFUSALS);
export type PluginInstallRefusal = (typeof PLUGIN_INSTALL_REFUSALS)[number];

/**
 * What an installer CONSENTED TO, on the row (ADR 0016 §5): the artifact pinned by hash, where
 * it came from as the installer spelled it, and the capability set granted — the roster is
 * where every principal reads a grant, so it lives here and nowhere else. `grantedCaps` is
 * intersected with the manifest's declared caps at rung 4, BEFORE the caller's own caps, so a
 * refusal names the plugin's grant rather than the caller. Attribution mirrors `changedBy` /
 * `changedAt` on the row: an install changes what everyone is looking at.
 *
 * `refusal` is why this install cannot SERVE right now, as distinct from the row's own
 * `refusal` (why it cannot be toggled): a bundle that no longer hashes to `sha256` at boot is
 * `hash_mismatch` here and `enable_failed` on the row, never loaded (R8, fail-closed).
 */
export const PluginInstallSchema = z.strictObject({
  sha256: z.string().length(64),
  /** The url or path as given, so an operator can tell where a stranger's code came from. */
  source: z.string().max(2048),
  grantedCaps: CapSchema.array(),
  installedBy: z.string().min(1).max(128),
  installedAt: z.number().int().min(0),
  refusal: PluginInstallRefusalSchema.optional(),
});
export type PluginInstall = z.infer<typeof PluginInstallSchema>;

/**
 * A plugin as the roster describes it: everything a client needs to render the plugin, its
 * doors, its state and WHO put it in that state, from one document.
 *
 * Attribution is on the row rather than in an event because enablement is workspace-global
 * and hot — one principal's toggle changes what everyone else is looking at, right now —
 * and a placeholder that can say "disabled by alex" is the difference between a change and
 * a glitch. Both fields are absent (or null, as a store row reads them) until someone
 * actually toggles the plugin.
 */
export const PluginRosterEntrySchema = z.strictObject({
  manifest: PluginManifestSchema,
  enabled: z.boolean(),
  source: PluginSourceSchema,
  actions: ActionSummarySchema.array(),
  /** Absent ≡ `ok`: the plugin's last transition did what it said. */
  lifecycle: PluginLifecycleStateSchema.optional(),
  /** Why this row cannot be toggled right now — a lock in the UI, not a hidden failure. */
  refusal: PluginRefusalReasonSchema.optional(),
  changedBy: z.string().min(1).max(128).nullish(),
  changedAt: z.number().int().min(0).nullish(),
  /**
   * Present iff the plugin was INSTALLED (ADR 0016 §8 stage 2): the row is a stranger's code
   * running isolated, and this block is what an installer consented to. Absent for every
   * in-realm row, first-party `plugin` and `builtin` alike — presence is what selects the
   * runner (§1), so there is no third `source` value to invent.
   */
  install: PluginInstallSchema.optional(),
});
export type PluginRosterEntry = z.infer<typeof PluginRosterEntrySchema>;

/**
 * The whole assembly, as every principal sees it: server-owned, served at
 * `GET /api/plugins`, and pushed on the connection-level `plugins` session frame whenever
 * it changes. Registration is shared state, never a client's private guess.
 */
export const PluginRosterSchema = PluginRosterEntrySchema.array();
export type PluginRoster = z.infer<typeof PluginRosterSchema>;

/**
 * THE DISCIPLINE ROSTER: discipline id → the declaration its plugin contributed, derived
 * from a published `PluginRoster` (#110).
 *
 * It is the container-side twin of `rosterElementTraits`, and it lives HERE — in the
 * protocol package, beside the roster shape it reads — rather than in the plugin engine,
 * because both halves of the system and `GET /api/protocol` itself need the same
 * projection, and a second walk of the same array is a second answer to "what disciplines
 * exist" waiting to disagree (invariant 14). One derivation, one door.
 *
 * DISABLED plugins are included, deliberately and for exactly the reason element traits
 * are: their containers are still in the index. A disable decides who RENDERS a container
 * (D4′ — the engine-owned placeholder), never what composes with it, and a container that
 * became unplaceable and un-unplaceable at once because somebody toggled a plugin is a
 * workspace nobody can tidy. UNINSTALLED is the different case, and the one that has no
 * row here at all: `unknown_discipline`.
 *
 * Iteration order follows the roster, and a duplicate id cannot reach here — assembly
 * refuses one, naming every claimant.
 */
export function rosterDisciplines(
  roster: PluginRoster,
): ReadonlyMap<string, DisciplineDeclaration> {
  const disciplines = new Map<string, DisciplineDeclaration>();
  for (const entry of roster) {
    for (const discipline of entry.manifest.contributes.disciplines ?? []) {
      disciplines.set(discipline.id, discipline);
    }
  }
  return disciplines;
}

/**
 * Why a dispatch was refused. The ladder is MONOTONIC and evaluated in this order, so a
 * caller learns the FIRST thing wrong rather than a summary: the action must exist, its
 * plugin must be enabled, the caller must be allowed to reach the door at all, the caller
 * must hold every declared cap, the arguments must parse, and only then may the handler
 * itself refuse on state it alone can see (`refused`).
 *
 * `unavailable` is the LAST rung and the isolation runner's alone (ADR 0016 §6): the door
 * exists, its plugin is on, the caller is allowed and the arguments would have been graded —
 * but the child process that holds the handler is not running (crashed past its budget) or
 * did not answer inside `ISOLATE_DISPATCH_DEADLINE_MS`. A hung isolate is a refusal, never a
 * stuck promise, and it is traced like every other rung. An in-realm door never answers it.
 */
export const ACTION_DENIAL_RULES = [
  "unknown_action",
  "plugin_disabled",
  "forbidden",
  "invalid_args",
  "refused",
  "unavailable",
] as const;
export const ActionDenialSchema = z.strictObject({
  rule: z.enum(ACTION_DENIAL_RULES),
  message: z.string(),
});
export type ActionDenial = z.infer<typeof ActionDenialSchema>;
export type ActionDenialRule = (typeof ACTION_DENIAL_RULES)[number];

/**
 * What the action door answers. A denial is a 200 carrying `ok: false` — the same shape
 * `core.space.place` uses for a refused placement, because a refusal is an ANSWER about
 * authority or state, not a transport failure.
 */
export const ActionOutcomeSchema = z.union([
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ok: z.literal(false), denial: ActionDenialSchema }),
]);
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;

/**
 * A BINDING's published name: its owning plugin's id followed by one local name
 * (`core.shell.arrange`), which is the same pair rule an action name obeys — a plugin can
 * never name a key outside its own namespace, and a full name always says who owns it.
 * Spelled as its own pattern rather than reused from {@link PluginIdSchema} because the last
 * segment is a LOCAL name and those admit interior capitals (`core.keys.setBinding`), while
 * every segment before it is a plugin-id segment.
 */
export const BINDING_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}\.[a-z][a-zA-Z0-9-]*$/;
export const BindingIdSchema = z.string().regex(BINDING_ID_PATTERN).max(96);
export type BindingId = z.infer<typeof BindingIdSchema>;

/**
 * ONE KEYSTROKE — an optional `Mod+` prefix followed by the value `KeyboardEvent.key`
 * reports: `F9`, `a`, `ArrowUp`, `?`, `Mod+k`. Bounded and otherwise unconstrained on
 * purpose: the browser owns this vocabulary, an editor captures the value from a real
 * keystroke rather than composing it, and a server that tried to enumerate legal keys would
 * be a second, always-stale keyboard map. The GRAMMAR is the engine's
 * (`@manifold/plugin`'s `parseKeystroke`), which is also why the bound has never moved: a
 * prefixed stroke was already a string this schema accepted, so a stored override written by
 * any build parses in every other.
 */
export const BindingKeySchema = z.string().min(1).max(24);

/**
 * ONE PRINCIPAL'S BINDING OVERRIDES: the keys this principal has rebound, as binding id →
 * key. Server-saved rather than device-local, because a principal is one actor across every
 * device they sit at (multiplayer-first, invariant 11) and a rebind that lived in one
 * browser's storage would be a fact no other client could read.
 *
 * An override is a DELTA, never a table: what a workspace answers to is the declared rows
 * with this map applied at composition (`composeBindings`), so a plugin that ships a new key,
 * a plugin that is disabled and a plugin that renames its own row all keep exactly the
 * meaning they have without anybody rewriting stored overrides. A row with no entry here
 * answers its declared default, which is why the empty map is the whole of "nothing rebound".
 *
 * Bounded at 64 entries: this is one principal's deltas over a key table a manifest bounds at
 * a handful of rows per plugin, and an unbounded per-principal map is a write door with no
 * ceiling.
 */
export const MAX_BINDING_OVERRIDES = 64;
export const BindingOverridesSchema = z
  .record(BindingIdSchema, BindingKeySchema)
  .refine((overrides) => Object.keys(overrides).length <= MAX_BINDING_OVERRIDES, {
    message: `at most ${MAX_BINDING_OVERRIDES} binding overrides`,
  });
export type BindingOverrides = z.infer<typeof BindingOverridesSchema>;

/**
 * A SETTING's published name: the declaring plugin's id followed by the local id its manifest
 * gave it (`core.canvas.new-canvas`).
 *
 * Composed from the two schemas that already own those halves rather than spelled as a third
 * regex — the pair rule is one rule, and a copy of it here would be a second answer to "what
 * may a qualified name look like" that drifts the first time either half changes.
 */
export const SettingRefSchema = z.templateLiteral([PluginIdSchema, ".", LocalNameSchema]);
export type SettingRef = z.infer<typeof SettingRefSchema>;

/**
 * ONE PRINCIPAL'S SETTING VALUES: the preferences they have expressed an opinion about, as
 * setting ref → value. Server-saved for the reason a rebinding is (invariant 11): a principal
 * is one actor across every device they sit at, so a preference held in one browser's storage
 * would be a fact none of their other clients could read.
 *
 * A DELTA over the declarations, never a table — the same discipline
 * {@link BindingOverridesSchema} keeps, and the reason a plugin may change its own default,
 * be disabled, or be removed entirely without anybody rewriting stored values. A ref with no
 * entry reads its manifest's `default`, which is why the empty map is the whole of "nothing
 * customized", and a stored ref no declaration answers is DROPPED at composition rather than
 * pruned from the store: a plugin turned off for a week must find its preferences intact.
 *
 * Values are booleans or declared enum strings.
 *
 * Bounded at 128 entries: a manifest may declare eight settings, so this is a ceiling on a
 * principal's deltas over a roster of some size rather than a limit any real workspace meets,
 * and an unbounded per-principal map is a write door with no ceiling.
 */
export const MAX_PLUGIN_SETTING_VALUES = 128;
export const PluginSettingValuesSchema = z
  .record(SettingRefSchema, SettingValueSchema)
  .refine((values) => Object.keys(values).length <= MAX_PLUGIN_SETTING_VALUES, {
    message: `at most ${MAX_PLUGIN_SETTING_VALUES} plugin setting values`,
  });
export type PluginSettingValues = z.infer<typeof PluginSettingValuesSchema>;

/**
 * The plugin vocabulary, published — the counterpart of `placementVocabulary()`. A
 * stranger's agent reading `GET /api/protocol` learns what a manifest may declare, what a
 * roster row can say about state and attribution, and every CLOSED set a refusal can name,
 * from the declarations themselves rather than from prose that drifts away from them.
 *
 * What this does NOT contain is which plugins a given server composed: that is the live
 * assembly, handed in through `ProtocolExtras`, because this package describes shapes
 * and never their inhabitants.
 */
export function pluginVocabulary(): Record<string, unknown> {
  return {
    engineNamespace: ENGINE_NAMESPACE_PREFIX,
    /*
      Published beside it because the reservation is a rule an AUTHOR has to know before
      choosing an id: `core.` is taken, and a manifest under it fails assembly unless the
      distribution registered it. What is NOT published is who inhabits the namespace — that is
      the live roster's answer, and this package describes shapes, never their inhabitants.
    */
    coreNamespace: CORE_NAMESPACE_PREFIX,
    sources: PLUGIN_SOURCES,
    dependencyTypes: PLUGIN_DEPENDENCY_TYPES,
    dormantModes: PLUGIN_DORMANT_MODES,
    defaultDormantMode: DEFAULT_DORMANT_MODE,
    residualMechanisms: PLUGIN_RESIDUAL_MECHANISMS,
    purgeTargets: PLUGIN_PURGE_TARGETS,
    lifecycleStates: PLUGIN_LIFECYCLE_STATES,
    refusalReasons: PLUGIN_REFUSAL_REASONS,
    /*
      The install door's own refusal classes and the block an installed row carries (ADR 0016
      §5, §8 stage 2): a stranger's agent installing a plugin learns what it may be told and
      what the roster will then say about the grant, from the same read as everything else.
    */
    installRefusals: PLUGIN_INSTALL_REFUSALS,
    install: z.toJSONSchema(PluginInstallSchema),
    denialRules: ACTION_DENIAL_RULES,
    actionScopes: ACTION_SCOPES,
    defaultElementPlacement: DEFAULT_ELEMENT_PLACEMENT_TRAITS,
    sectionPresentations: SECTION_PRESENTATIONS,
    defaultSectionPresentation: DEFAULT_SECTION_PRESENTATION,
    toolbars: TOOLBARS,
    defaultToolbar: DEFAULT_TOOLBAR,
    defaultSeatRatio: DEFAULT_SEAT_RATIO,
    seat: z.toJSONSchema(SeatDefSchema),
    manifest: z.toJSONSchema(PluginManifestSchema),
    action: z.toJSONSchema(ActionSummarySchema),
    outcome: z.toJSONSchema(ActionOutcomeSchema),
    rosterEntry: z.toJSONSchema(PluginRosterEntrySchema),
    purgeResult: z.toJSONSchema(PluginPurgeResultSchema),
    /*
      The rebind vocabulary, published beside the manifest's: an agent reading this learns
      that keys are declared by plugins and overridden per principal, and what shape a
      `GET /api/bindings` answer and a `core.keys.setBinding` argument take.
    */
    maxBindingOverrides: MAX_BINDING_OVERRIDES,
    bindingOverrides: z.toJSONSchema(BindingOverridesSchema),
    /*
      The settings vocabulary, on the same terms: which value kinds a declaration may take,
      and what shape a `GET /api/settings` answer and an `engine.plugins.setSetting` argument
      take. The DECLARATIONS themselves ride in the manifest schema above — a setting is a
      contribution, so an agent reading `manifest` already knows how one is spelled.
    */
    settingKinds: SETTING_KINDS,
    settingScopes: SETTING_SCOPES,
    maxPluginSettingValues: MAX_PLUGIN_SETTING_VALUES,
    pluginSettingValues: z.toJSONSchema(PluginSettingValuesSchema),
  };
}
