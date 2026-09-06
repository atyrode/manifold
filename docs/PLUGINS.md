# Writing a manifold plugin

**Read this if you are an agent.** This file plus two live endpoints are the complete
onboarding surface; you should not need to read manifold's source to author a plugin.

**Two authoring targets, and the manifest decides.** The first is a package inside this
repository — `packages/plugins/<name>`, registered in the two assembly files (§1) by a
maintainer and rebuilt with the tree; it is what §1–§8 describe, and it is handed the engine's
real objects. The second is an ISOLATED plugin (§9, ADR 0016): authored anywhere against
`@manifold/plugin-kit`, packed into one artifact, installed at `engine.plugins.install` and run as
a stranger's code in its own process and its own `Worker`, against a narrower, documented
interface. A manifest with `entry` is the second kind. Two places below point at the engine's
own source for a shape — the registration shape in §6 and the web registration channels in §7 —
and they are the named exceptions to the promise above, flagged as maintainer-only where they
occur; neither applies to an isolated plugin.

```sh
curl -H "authorization: Bearer $TOKEN" http://localhost:7777/api/plugins    # the live roster: every plugin, its manifest, whether it is enabled, its actions
curl -H "authorization: Bearer $TOKEN" http://localhost:7777/api/protocol   # JSON Schemas for the wire, every assembled action's input/result, and `pluginContract` — the whole plugin vocabulary as data
```

The roster is authoritative. If this document and `GET /api/plugins` disagree about what
exists, the endpoint is right and this document has a bug — report it. Prose never lists the
core plugins; `packages/plugins/*` and the roster do.

Everything above the foundation floor is a plugin. The floor is a machine-readable registry in
`REGISTRY.md` (fenced JSON, checked in both directions by `bun run verify:axioms`), not a
judgement call: identity and auth, protocol schemas, the plane transports, persistence, and
the registry itself. Anything else — the sidebar, the drawing tool, the terminal lifecycle,
vantage presence, the shell — is plugin territory, and the shipped ones are your worked examples.

---

## 1. Anatomy

A plugin is a workspace package under `packages/plugins/<name>`, published as
`@manifold-plugin/<name>`, exporting up to three halves:

```jsonc
// packages/plugins/draw/package.json
{
  "name": "@manifold-plugin/draw",
  "exports": {
    ".": "./src/index.ts", // the manifest + action definitions (shared)
    "./server": "./src/server.ts", // action handlers (omit if the plugin has no server half)
    "./web": "./src/web.tsx", // panels, sections, element renderers, tools (omit if headless)
  },
}
```

A plugin is registered in exactly two places — `packages/server/src/assembly.ts` and
`packages/web/src/assembly.ts`. There is no discovery, no filesystem scan, no load order:
assembly is data, and an unregistered package is not a plugin.

Your dependency budget is `@manifold/protocol`, `@manifold/scene`, `@manifold/sdk`, and
`@manifold/plugin`. Importing anything else from the tree — server internals, web internals,
another plugin — fails the gate.

`@manifold/plugin` has three entries, and which one you reach for is a real distinction:

| entry                    | what it holds                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@manifold/plugin`       | the registry and the contracts — manifests, `defineAction`, host types. Platform-free, because the SERVER assembles through it.                        |
| `@manifold/plugin/hooks` | plane mechanism in a browser: the carry/drop vocabulary, the element host, `usePolledResource`.                                                        |
| `@manifold/plugin/ui`    | the standard library for looking like manifold: `ItemIcon`/`ControlIcon`, `NodeTitleBar`, `useNotice`, and the published vantage store (`setVantage`). |

`/ui` is a standard library rather than a component kit: you extend it by passing nodes into its
slots (`icon`, `middle`, `extraActions`), never by growing a component's props, so re-drawing the
whole icon set stays a change to one file and no call site. What is CLOSED there is
`ControlKind`: a fixed list, closed to ADDITIONS and not to callers — you may not grow the
union, and you are expected to call it, because a plugin's chrome should wear the same mark for
the same verb the shell's chrome does. The rule that keeps the list honest is on the NAME: every
kind is a neutral verb (or, for `bindings`/`assembly`, a neutral noun naming what pressing
opens), so the list would read the same with every plugin in this build replaced. #116 deleted
the two kinds that broke it (`endTerminal`, `terminalTree` — a plugin's object in the floor's
vocabulary, and dead besides) and migrated the three plugins that broke it from the other side,
by hand-importing lucide and re-implementing the one wrapper. Meanwhile a vocabulary the
ASSEMBLY owns stays open: `ItemIcon` takes any item kind, your contributed element types
included, and draws a neutral element mark for a kind it holds no drawing for (#69 wave F).
`@manifold-plugin/terminals/web` is the worked example: its terminal viewer owns no drawing and
no notice mechanism of its own.

**Never import `lucide-react` in a plugin.** Ask for a kind
(`<ControlIcon kind="discard" />`, `<ItemIcon kind={container.discipline} />`) and pass `size`
when your rhythm is not 16px. A drawing you import yourself is a mark that stops moving when the
set is re-drawn, and every wrapper prop you retype (`className="mf-icon"`, `strokeWidth`,
`absoluteStrokeWidth`, `aria-hidden`) is a chance to retype one of them wrongly.

### A part lives inside its parent's package

A plugin may be a PART of another — `core.canvas.draw` is part of `core.canvas`,
`atyrode.code.generator` is part of `atyrode.code` — and the id is what says so (ADR 0023,
ratified 2026-09-05; the rule binds every new plugin now). Decide part or peer with one litmus,
both halves required: **nouns** — everything you contribute is about the parent's nouns (its
element kinds, its tools, its tiles, its catalog) and you introduce no top-level noun of your own —
and **existence** — with the parent disabled you have NOTHING to do, not less to do. Fail either
and you are a peer with a `dependencies` edge. A contribution about a third plugin's noun is an edge
too, never a disqualification: nest where your existence lives, edge where you borrow a noun.
Two shapes pass. An EXTENSION adds to what the parent draws (a stroke on a canvas). A PRODUCT PART
is one face of a baseline that owns the shared state and doors, free to own panels of its own
(`atyrode.code` / `.generator` / `.usage` / `.accounts`). Split where the capability ceiling or
independent use genuinely differs, and never deeper than three segments (§2).

A part's manifest carries `dependencies: { "<parent>": { type: "required" } }` — the id is the
claim, the edge is the proof, and assembly refuses one without the other (§7, `orphan_child`).
Nothing else about you changes: your own manifest, your own roster row, your own capability
ceiling, your own `ctx.storage` namespace, your own purge, your own toggle. The parent hands
down no capability and no data, and no toggle cascades either way: the parent cannot be turned
off while you are on (`missing_dependency`, naming you), and while it is off your row reads
`dependency_disabled`, exactly as any dependent of an off plugin does (§2, `dependencies`; §4).

A part is a DIRECTORY inside its parent's package, never a package of its own:

```jsonc
// packages/plugins/canvas/package.json — the parent grows subpath exports, one level
{
  "name": "@manifold-plugin/canvas",
  "exports": {
    ".": "./src/index.ts",
    "./web": "./src/web.tsx",
    "./contract": "./src/contract.ts", // what a part may import: element kinds, tool and registration types, vocabulary
    "./draw": "./draw/src/index.ts", // the part's manifest + actions
    "./draw/web": "./draw/src/web.tsx", // omit halves the part does not have, as for any plugin
  },
}
```

npm allows one slash in a package name, so `@manifold-plugin/canvas/draw` can only ever be a
subpath; the workspace glob does not change and no hyphenated package appears. The parent's
`tsconfig.json#include` widens to the part's directories, and the part's third-party dependencies
— which a plugin may not have beyond the four floor packages anyway — would live in the parent's
`package.json`, which is a signal you may be a peer. Registration is unchanged: a part is its own
plugin def in both `assembly.ts` files, reached through the parent's subpath.

Imports follow the tree, and nothing else. A part imports, of its parent, ONLY the `contract`
subpath — never `./web`, never `./server`, never a path into its `src/` — so it can share the
parent's vocabulary without reaching its runtime state or components. The parent NEVER imports a
part: that is what makes "canvas without draw" literally true. Parts never import each other and
peers never import each other — doors only, as today. The `contract` module itself imports only the
four floor packages and names no React or DOM type, so it cannot smuggle runtime either way. The
gate check for this is S18 (`REGISTRY.md` §Gates) — ratified, not yet enforced: it lands with
[#261](https://github.com/atyrode/manifold/issues/261), and until then S2's budget (above) is the
check that runs. Out-of-tree plugins (§9) are untouched at runtime — their bundles import no in-tree
code — and the same directory convention applies in their own repositories.

### Your skin ships with you

A plugin that paints anything carries `src/styles.css` and imports it from its web half:

```tsx
// packages/plugins/<name>/src/web.tsx
import "./styles.css";
```

Vite follows the edge and emits your rules into the built CSS, so the sheet arrives with the
code that paints against it and leaves with the package. The floor's stylesheet is NOT the
place to put them, and that is now mechanical rather than a request: `REGISTRY.md` §Lexicon's
`cssFamilies` registry names one owning stylesheet per selector family, and S13 fails a family
painted from anybody else's file. Adding a family is one registry row, in the same commit —
the same cheap direction as adding a lexicon term.

Two consequences worth knowing before you write a selector. Your rules may reach INTO your own
subtree only: ownership follows the leftmost family in a selector, so `.my-panel .node-titlebar`
is yours while a bare `.node-titlebar` rule is the neutral chrome's and belongs in
`packages/plugin/src/ui/styles.css`. And a rule with no class at all — `body`, `:root`, an
element default — is the floor's alone, because it reaches every node in the document.

The TypeScript side needs one line of setup: your `tsconfig.json` names
`../../plugin/src/css-modules.d.ts` in its `include`, which is where the `declare module "*.css"`
contract lives so nine packages do not each declare it.

---

## 2. The manifest

The manifest is **inert data**. It has no executable fields, nothing is interpolated, and the
server validates it with a strict schema (unknown keys are rejected).

```ts
import type { PluginManifest } from "@manifold/protocol";

export const manifest: PluginManifest = {
  id: "core.draw", // /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, max 64 chars
  version: "1.0.0", // display only
  title: "Draw",
  description: "Freehand strokes on the canvas.",
  capabilities: ["scenes:write"], // the union of everything this plugin's actions may need
  // essential: true,              // optional; seven shipped seats claim it
  dataVersion: { major: 1, minor: 0 }, // the shape of the data you store
  dependencies: {
    "core.canvas": {
      type: "optional",
      reason: "the drawing tool needs a canvas; a drawing in a composition renders independently",
    },
  },
  after: ["core.shell"], // soft ordering only; a missing target is ignored
  dormant: { mode: "ghost", label: "Drawing (plugin disabled)" }, // how your stuff looks while you are off
  purges: ["storage", "elements", "ownership"], // audit visibility: what a purge would destroy
  contributes: {
    panels: [], // { id, title, arranges? } — a workspace tile leaf. `arranges: { title }` says
    //            your panel contains an arrangement of its OWN and names it (below).
    seats: [], // { panel, order, ratio? } — OPTIONAL, and absent means you seat nothing.
    //            Where one of YOUR panels asks to sit in a workspace nobody has arranged:
    //            the engine composes that default from every enabled plugin's seats, in
    //            `order`, as one row of leaves. `ratio` is a weight against its siblings
    //            (default 1). core.shell seats its two at 0.22 and 0.78, which is the
    //            classical workspace; declare a seat and yours appears in a fresh
    //            workspace without anybody editing the floor (ADR 0017 §3).
    sections: [], // { id, title, order, presentation?, cluster? } — a sidebar row; presentation
    //            is "disclosure" (default: a titled block that folds) or "plain" (you draw the
    //            whole row). `cluster` is a bare word: rows sharing it paint side by side as one
    //            unit at the earliest member's place. One registry, one reader-arranged order.
    disciplines: [], // { id, title, item, accepts, guards, destinations } — container renderers (below)
    elements: [
      {
        type: "draw",
        title: "Drawing",
        placement: { groups: ["tileable", "canvas_item"], guards: [], homed: "on_claim" },
        presentation: { canvas: "body", composition: "titlebar" },
      },
    ],
    // `tools` are toolbar tools. `toolbar` NAMES THE BAR the tool paints into, from the
    // engine's closed vocabulary — `canvas` (the freeform discipline's tool strip) or
    // `arrange` (`core.arrange`'s floating F8 workspace editor). Absent ≡ `canvas`.
    // A row on the `arrange` bar may be painted as a DRAG SOURCE rather than a button:
    // that is core.arrange's own reading of its own tool rows, not a field you declare.
    tools: [{ id: "draw", title: "Draw", toolbar: "canvas" }],
    events: [], // event kinds THIS plugin originates (§6b); core.draw emits none — a stroke is a document edit
  },
  // entry: { web: "...", server: true }, // reserved: dynamic distribution, a later wave
};
```

Rules worth knowing before you write one:

- **The id must be dotted** — at least one `.` — and it namespaces everything you contribute.
  A panel `sidebar` contributed by `core.shell` is globally `core.shell.sidebar`. TWO prefixes are
  **reserved**: `engine.` belongs to the engine's own builtin doors, and `core.` is manifold's own
  authorship — assembly refuses any plugin claiming either (the second unless the shipped
  distribution registered it). Pick your own leading segment (`example.notes`); it needs no
  registration anywhere and buys you exactly what `core.` buys manifold, which is nothing but a
  name (§7, "Three orthogonal facts about a plugin"). **Two segments claim nothing; a THIRD
  segment claims a home** — `example.notes.tags` says it is a part of `example.notes`, and the
  manifest must prove it with `dependencies: { "example.notes": { type: "required" } }` or assembly
  refuses it (§1, "A part lives inside its parent's package"; §7). **Depth stops at three**:
  `publisher.product.part`, no fourth segment — `PLUGIN_ID_PATTERN` is
  `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}$` (ratified; the schema still admits any depth until
  [#261](https://github.com/atyrode/manifold/issues/261) lands, so treat the cap as binding now).
- **Contribution ids are local names** (`^[a-z][a-zA-Z0-9-]*$` — interior capitals are allowed
  where the name is a verb phrase, as in `setEnabled`), with exceptions that are WIRE kinds
  and therefore globally unique on their own: discipline `id` (below), element `type`, and event `id`, which is
  `snake_case` (`^[a-z][a-z0-9_]*$`, max 48) because the audit log has spelled its kinds that way
  since before the plane existed and one concept gets one spelling.
- **`panels[].arranges` declares an inner arrangement**, and it is the whole of what the floor
  learns about it. Arrange mode (F8) is SCOPED: at the root the reader moves the workspace's
  panels; a panel that declares `arranges: { title }` grows a way in on its own name, and
  stepping through it publishes `vantage.arrangeScope = "<yourPlugin>.<panel>"` — at which point
  nothing else in the workspace is reachable and your panel's parts are. The engine renders the
  control, labels it with your title, prints the crumb `Workspace › <title>`, and knows nothing
  else: WHAT is in there, how it reorders and where it commits stay yours. Read the scope with
  `useVantage()` and compare it against your own panel ref (`panelRefId(manifest.id, "panel")`)
  — that comparison is how your parts decide whether they are reachable, and it is the only
  wiring the mode needs from you. Absent ≡ nothing to arrange inside, which is every panel that
  never says otherwise. `core.shell.sidebar` declares `{ title: "Sidebar rows" }`.
- **`capabilities` is a ceiling, not a request.** Every action's declared caps must be a subset
  of it; a violation refuses composition. It exists so a reader can see a plugin's maximum
  authority without reading its actions. **The permission waterfall (ADR 0011) did not change
  this.** A door intersects two sides: what the ACTION declares it needs, and what the CALLER is
  evaluated to hold. Grants on the node tree replaced the second side only — a manifest still
  bounds what your actions may DECLARE, in the same flat cap vocabulary, and you never write a
  grant to raise your own ceiling. If a manifest had to grow a node or an effect to keep working,
  the two sides were never orthogonal in the first place.
- **`dependencies` are declared per plugin id** with a `type` of `required`, `optional` or
  `incompatible`, plus an optional `reason` that is shown to whoever hits the refusal. A missing or
  disabled `required` dependency, or a present `incompatible` one, refuses assembly naming both
  sides. There is **no enable cascade** at the door: enabling you never silently enables anything
  else, and disabling a plugin that others require is refused, naming them. A family (a parent and
  its parts, §1) is no exception — the manager turns one off by pressing each part's toggle and
  then the parent's, N+1 dispatches through the same door, every one traced, and stops at the first
  refusal.
- **`after` is ordering, not requirement.** It contributes to the deterministic order the engine
  composes and fires lifecycle hooks in (topological over `dependencies` ∪ `after`, ties broken by
  lexicographic id). A cycle is an `AssemblyError`.
- **`dataVersion` governs your stored rows** (§4). Bump `minor` freely; bumping `major` without a
  migration refuses to assemble your plugin, and data written by a newer `major` than your code
  refuses too — the engine never guesses at your schema.
- **`links` says where you come from**: `repository`, `homepage` and `changelog`, each an
  `https://` URL, all optional. The plugin manager shows `repository`; the update flow (#238)
  reads `changelog` to say what a newer version changes. Absent ≡ you said nothing.
- **`dormant` is how your contributions look while you are disabled**: `ghost` (the engine's inert
  placeholder, naming you — the default) or `hide` (record kept, nothing painted), plus an optional
  `label`. It is **data, not a component**: the engine draws the placeholder, because a plugin that
  is off cannot be asked to render its own absence. Omitting the field is a real declaration
  (absent ≡ `ghost`), and `hide` is for chrome only — never for a node holding a user's work (§6).
- **`essential: true` means the workspace cannot be drawn without you.** Seven plugins claim it,
  in two families. The RAIL'S NON-NEGOTIABLES: `core.shell` (the panels), `core.brand`,
  `core.keys` and `core.plugins` (issue #91). The SEATS THE FLOOR DISPATCHES: `core.space` (the
  only writer of a workspace tile tree, the placeholder's own pruned commit included),
  `core.index` (the only door that mints or reads a container) and `core.access` (the only path
  from a credential to an identity) — each named by `packages/web/src/assembly.ts`, because a
  floor that dispatches a door may not have that door taken away underneath it (issue #113, ADR
  0013 addendum 2026-09-01). Attempting to disable an essential plugin returns
  `{ ok: false, denial: { rule: "refused", message: "essential" } }`, where the message is one
  member of the published refusal-class set (`essential`, `builtin`, the dependency classes, the
  data-version classes, `still_enabled`, …) — never free-form text. Essential protects the SEAT,
  never a mechanism: `core.plugins` is still the manager UI only, and the enablement door it
  presses is the engine's own builtin row, reachable over the API with `plugins:manage` even if
  every UI were gone. A boot that finds an essential seat off — reachable only out of band, since
  the door refuses it — offers "Restore default plugins" at the identity gate, one dispatch per
  shipped row.
- **Element contributions carry placement traits.** An element declares how it behaves in the
  placement algebra as manifest data, so the algebra never has to learn your kind's name:

  ```ts
  placement: {
    groups: ["canvas_item"],   // PlacementGroup[]: tileable | mergeable | unplaceable | embeddable
                               //   | canvas_item | canvas_item_as_portal | extractable
    guards: [],                // ItemGuard[]: no_self_embed | solo_only
    homed: "inline",           // HomingMode: eager | on_claim | inline — or null for "no home"
  }
  ```

  `placement` is optional, and omitting it means `DEFAULT_ELEMENT_PLACEMENT_TRAITS`
  (`{ groups: ["canvas_item"], guards: [], homed: "inline" }`, exported from the protocol — the
  default). When you DO declare it, all three fields are required: `homed: null` is how
  you say "no home", not omission. Draw and Notes instead declare `tileable` plus `canvas_item`
  with `on_claim` homing, so placement can move their element into a composition. There is no
  canvas-operation key — the op is derived by the
  algebra, which is the half that stays engine (ADR 0013 §12). The container-site-only guard
  `discipline_match` is refused on an element. Every closed wire literal is `snake_case`.

- **Element presentation is declared per discipline**, independently of placement:
  `presentation?: Record<ContainerDiscipline, "body" | "titlebar">`. The map uses discipline
  names (at most 32 entries) and stays optional through `RegisteredElement`; omitting a
  declaration does not manufacture one in the manifest. Canvas reads
  `projection.element(type)?.presentation?.["canvas"] ?? "titlebar"` rather than branching on
  plugin/type names. Its own builtin portal uses shared titlebar policy. Notes and Draw declare
  `{ canvas: "body", composition: "titlebar" }`: inline content keeps its natural text/ink
  presentation while a composition always titles its occupant. Unknown/unavailable elements
  get a sensible titled placeholder; no declaration may make missing work an unlabelled hole.
  Draw and Notes use the same `{ kind: "element", elementId }` tile reference. Its scene
  record lives in the composition's document; the contributed type selects its renderer.

- **`purges` is a declaration for audit, never a trigger.** It says which of the closed purge
  targets (`storage`, `elements`, `ownership`) you hold, so a human can see what
  `engine.plugins.purge` would cost before pressing it. Nothing about disable reads it.
- **`events` declares the event kinds you originate** (§6b). The id is `snake_case` and globally
  unique: a kind belongs to one plugin, and the engine refuses an emission of a kind another
  manifest declared. `entry` is still reserved — write it if you like; nothing reads it this wave.

### Disciplines

**`contributes.disciplines` declares the containers your plugin renders**, not element types or
leaf kinds. The optional array holds at most four declarations; absent means you render no
container of your own ([manifest schema](../packages/protocol/src/plugin.ts),
`ContributesSchema.disciplines`). A discipline is the value stored in
`Container.discipline` and the key your web half uses in `renderers`.

Every field below is required on each row; unknown fields are refused. The shape and the closed
placement vocabulary are
[`DisciplineDefSchema` and `PlacementTraitsSchema`](../packages/protocol/src/placement.ts):

| Field | Meaning |
| ----- | ------- |
| `id` | Global discipline id, matching `^[a-z][a-z0-9-]*$`, at most 32 characters ([`ContainerDisciplineSchema`](../packages/protocol/src/layout.ts)). It is not prefixed by the plugin id and need not equal its last segment. |
| `title` | Display noun, 1–64 characters. |
| `item` | Placement traits of a container of this discipline when that container is itself the item being placed; all three fields below are required. |
| `item.groups` | Groups the container belongs to: `tileable`, `mergeable`, `unplaceable`, `embeddable`, `canvas_item`, `canvas_item_as_portal`, `extractable`; at most seven entries. |
| `item.guards` | Item-site guards: `no_self_embed` (refuse self-embedding), `solo_only` (only a single occupant merges), `tree_only` (structure needs an existing tree); at most three entries. |
| `item.homed` | `eager` (home born with the item), `on_claim` (home materializes when placement first needs it), `inline` (exists in its document or row), or `null` (no home applies). |
| `accepts` | Groups this container accepts as a destination, from the same seven-value vocabulary as `item.groups`; at most seven entries. |
| `guards` | Container-site guards: only `discipline_match` is available, so at most one entry. It checks that the destination form appears in `destinations`; omitting this guard does not enforce that list. |
| `destinations` | Destination forms that may address this discipline: `canvas`, `tile`, `compose`, `unplaced`; at most four entries. These are the existing wire forms, not new discipline ids or leaf kinds. |

The shipped [`core.compositions` manifest](../packages/plugins/compositions/src/index.ts)
declares this row:

```ts
disciplines: [
  {
    id: "composition",
    title: "Composition",
    item: {
      groups: ["mergeable", "unplaceable", "canvas_item_as_portal"],
      guards: ["no_self_embed", "solo_only"],
      homed: "inline",
    },
    accepts: ["tileable", "mergeable"],
    guards: ["discipline_match"],
    destinations: ["tile"],
  },
];
```

Here `core.compositions` owns `composition`: the spelling is deliberately not a last-segment
rule. [`assembleRoster`](../packages/plugin/src/assemble.ts) claims every discipline id globally
and refuses duplicates with an `AssemblyError` naming the claimants, including disabled plugins;
turning a plugin off does not make its name available. Choose an unclaimed id for your own row.

**Register who draws it in the web half**, under that exact discipline id. The shipped
[`compositionsWebPlugin`](../packages/plugins/compositions/src/web.tsx) registers
`{ id: "core.compositions", renderers: { composition: CompositionView } }`.
For your own plugin, substitute your plugin id, your declared discipline id and your component,
and register both halves through the assembly files (§1). This is the in-realm authoring channel;
the isolated web kit currently serves panels only (§9), not container renderers.

Your component receives
[`ContainerRendererProps`](../packages/plugin/src/projection.ts), imported from
`@manifold/plugin/hooks`, whether routed or embedded in another container:

| Field | Meaning |
| ----- | ------- |
| `host` | Required `HostServices`: the mounting host's client, principal, token and assembly (§6 Host services). |
| `containerId` | Required string identifying the container to project. Use this address, not the host's routed container id, for an embedded renderer. |
| `containers` | Required `readonly Container[]`: all containers the index knows, for local placement resolution. |
| `presence` | Required `readonly Attendance[]`: attendance supplied by the mount site. |
| `soloOccupants?` | `ReadonlyMap<string, PlacementItem>`: the index's single-occupant composition fold, which an embedded renderer cannot compute itself. |
| `navigate` | Required `(path: string) => void` navigation callback. |
| `depth?` | Container nesting depth: 1 when routed, 2 when embedded one level down. |
| `projectionScope?` | `ProjectionScope \| null`: mounted ancestry and its root attendance client (§6 Mounted location and shared titlebars). |
| `frame?` | `"window"` (default, outer frame) or `"tile"` (square seams against adjacent leaves). |
| `titlebarDragProps?` | `TitlebarDragProps`: drag affordance to forward to the shared titlebar. |
| `titlebarExtras?` | `ReactNode`: extra titlebar actions. |
| `titlebarMiddle?` | `ReactNode`: middle titlebar content. |

The shipped [`CompositionView`](../packages/plugins/compositions/src/composition-view.tsx)
opens its own room pipe with `host.token` and registers it through `useRoomPipeRegistration`
(§6 Terminals through the handle); route-only services come from `useContainerRoute`, not extra
renderer props. The [`ContainerRenderer` outlet](../packages/plugin/src/projection.ts) selects by
`layout={container.discipline}` and forwards the props above. A missing registration paints
`unknown`, a disabled registrant paints `disabled`, and a registered row with no component paints
`unavailable`, using the engine's placeholder rather than asking your component to draw its absence.

**Create and place through the existing doors.** `core.index.createContainer` takes
`{ name, discipline }` ([action declaration](../packages/plugins/index/src/index.ts),
[`CreateContainerRequestSchema`](../packages/protocol/src/http.ts)); pass your declared id
explicitly. To land an item, call `host.client.place({ ref, destination })`, the same envelope as
`core.space.place` ([shipped action](../packages/plugins/shell/src/index.ts),
[`PlaceRequestSchema`](../packages/protocol/src/placement.ts)). `destination.kind` is an existing
form, not your discipline id: `canvas` names a container and coordinates; `tile` names a container,
tile and edge. The placement algebra reads the target's declaration, matches the item's groups
against `accepts`, and applies item/container guards. `compose` creates a composition from canvas
elements and `unplaced` enters no container; neither invents a new destination form for your plugin.

> **Current limitation — [#134](https://github.com/atyrode/manifold/issues/134).** Declaring
> `destinations: ["tile"]` does not yet make a third-party discipline a working tile tree.
> The [placement executor](../packages/server/src/placement.ts) still decides tile-tree-ness by
> the literal `"composition"` in execution/lifecycle paths and mints homes with that discipline;
> the census also reports the shipped composition kind. A custom declaration and renderer can
> register, but tile placement, removal and retirement are not an end-to-end third-party
> contract yet. Do not copy the composition row above under a new id expecting a working tile tree.

---

## 3. Actions

An action is a discrete, named, authority-checked mutation. It is the only way a plugin
changes the world.

```ts
import { defineAction } from "@manifold/plugin";
import { z } from "zod";

export const rename = defineAction({
  name: "rename", // LOCAL name; full name is `core.terminals.rename`
  title: "Rename terminal",
  caps: ["terminals:write"], // MUST be ⊆ manifest.capabilities
  input: z.strictObject({ terminalId: z.string().min(1), name: z.string().min(1).max(120) }),
  result: z.strictObject({ terminalId: z.string(), name: z.string() }),
});
```

Two optional fields on an action are declared carve-outs from exactly one rung of the denial ladder,
and they are the only ones:

- **`cleanup: true`** — for an action that REMOVES things. The dispatcher then skips only the
  `plugin_disabled` rung, so disabling your plugin refuses creation and administration but never
  locks anyone out of deleting what already exists (D12; `core.terminals.kill` is the canonical
  example).
- **`scope: "container"`** — for a door a container-scoped token should be able to call. It skips
  only the
  container-scope rung. The test is parity, NOT whether you read or mutate: declare it if and only
  if the
  route or channel verb you are replacing was reachable by a container-scoped token. Reads of one
  container qualify (its index rows, its terminals), and so do mutations inside one container —
  opening,
  renaming or killing a terminal, renaming the container itself, minting an attenuated token in it.
  It comes with an **obligation**: the ladder proved the caller's caps hold for the caller's own
  container, so your handler must prove that the thing NAMED in the arguments lives there. Do not
  hand-roll it — the engine owns the check and its wording:

  ```ts
  const denial = ctx.outsideScope(terminal.containerId); // resolve the container your ARGS name
  if (denial !== null) return denial; // canonical: OUTSIDE_SCOPE_REFUSAL
  ```

  Declare the slice you use — `{ outsideScope(containerId: string | null): { readonly refused: string } | null }`
  — and import `OUTSIDE_SCOPE_REFUSAL` in tests rather than retyping the string. The refusal never
  names the target container (a scoped caller learns nothing about a container it may not reach),
  and a
  `null` container is refused for a scoped caller while passing for a workspace-grade one.

  The three ways to discharge the obligation are **not interchangeable**:

  1. **Call `ctx.outsideScope`** — required whenever your arguments name a container-addressed node
     (a terminal, element, folder, layout, container).
  2. **Lean on a mechanism** — legitimate ONLY if that mechanism refuses on the CALLER'S OWN SCOPE,
     the way the identity mechanism refuses a mint that widens its minter's scope. _A mechanism
     discharges the obligation only if it refuses on the caller's own scope; validating the argument
     is not confining it._ "The row exists and parses" discharges nothing.
  3. **Vacuous** — nothing in your answer is addressed by container (a fleet-wide list). Write the
     reason
     as a comment on the handler, or the next reader adds a filter and breaks share-link viewers.

  Leave the default `"workspace"` for anything genuinely workspace-wide and for owner-only doors.
  See `docs/decisions/0013-plugin-behavioral-contract.md` §15.

Caps and schemas still apply in both cases: a carve-out skips one rung, never the intersection.

One door in that list is easy to misread. **`core.terminals.open` never creates a terminal.** It
is the authorization gate: it answers "may a terminal be created here, now, by you", and the
session channel dispatches it before it honours a `terminal_open` frame. The PTY itself is born on
the session socket — `host.client.openTerminal` from plugin code, `SessionClient.openTerminal`
from an agent or a tool (§Host services names the whole terminal surface) — because a create is a
round trip to a machine whose reply — snapshot watermark, controller lease, the opener's
correlation ref — is channel traffic the floor owns. Dispatching `core.terminals.open` over
`POST /api/actions/…` returns the decision and nothing else, and there is no action that creates
a terminal; whether there should be one is the open design question in #185.

Every handler can declare a `{ readonly traceId: number }` context slice to reference the
write-ahead trace authorizing its dispatch. This is the ledger row's `id`, exactly as
`core.events.list({ kind: "trace" })` returns it, already durable before your handler runs.
Use it in domain records without searching by door, principal or time; only the dispatch ladder
may write or settle traces. Refusals before invocation do not reach your handler.

The server half supplies the handler:

```ts
// src/server.ts
export const serverDef = {
  manifest,
  actions: [rename, kill],
  handlers: {
    rename: async (ctx, args) => {
      if (ctx.broker.rename(args.terminalId, args.name) === "not_found") {
        return { refused: "no such terminal" }; // → denial rule "refused"
      }
      return { terminalId: args.terminalId, name: args.name };
    },
  },
};
```

`ctx` is the only host door a handler sees — principal, auth context, store, rooms, broker.
Return the result value on success, or `{ refused: <message> }` to deny. The returned value is
validated against your `result` schema; a mismatch is a server error, not a denial, because it
is your bug.

### Calling one

```
POST /api/actions/core.terminals.rename
authorization: Bearer <token>
content-type: application/json

{"terminalId":"ts_abc","name":"build"}
```

The response is always 200 with an `ActionOutcome`:

```jsonc
{ "ok": true, "result": { "terminalId": "ts_abc", "name": "build" } }
{ "ok": false, "denial": { "rule": "forbidden", "message": "terminals:write capability required" } }
```

Denials are outcomes, not HTTP errors — the same shape the placement door returns when it names
the placement rule that refused (`core.space.place`). From a client,
`client.action(name, args)` on the SDK `SessionClient` returns the same object.

### The denial ladder

Dispatch runs one monotonic ladder. The first rule that fires wins, and no later step can
argue an earlier denial back to allow:

| #   | Rule              | Fires when                                                                                                                                                                                                                                                                                                |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `unknown_action`  | No assembled action by that full name.                                                                                                                                                                                                                                                                    |
| 2   | `plugin_disabled` | The owning plugin is disabled in this workspace. Skipped for actions declared `cleanup: true` (D12).                                                                                                                                                                                                      |
| 3   | `forbidden`       | The caller's token is **container-scoped** and your action's `scope` is `"workspace"` (the default). Message: `scoped tokens cannot invoke workspace actions`. Declare `scope: "container"` when the door you replaced was reachable by a scoped token.                                                   |
| 4   | `forbidden`       | The caller lacks one of the action's declared caps **at the node it is asking about** — its own container for a scoped token, the workspace root for an unscoped one (ADR 0011).                                                                                                                          |
| 5   | `invalid_args`    | The payload fails the action's `input` schema.                                                                                                                                                                                                                                                            |
| 6   | `refused`         | The handler returned `{ refused }`, or the engine refused by class — e.g. `essential`, `builtin`, `still_enabled`.                                                                                                                                                                                        |
| 7   | `unavailable`     | The door's plugin is INSTALLED (ADR 0016) and nothing is there to answer: its child crashed past `ISOLATE_CRASH_BUDGET`, sat silent past `ISOLATE_DISPATCH_DEADLINE_MS`, or its bundle failed re-verification at boot (`bundle failed verification at boot: <class>`). An in-realm door never answers it. |

Rule 3 is the same precedent as every workspace route, and the permission waterfall
(`docs/decisions/0011-permission-waterfall.md`) left it exactly where it was: a scoped token
still cannot invoke a workspace-graded door, because the grade is a property of the ACTION and
not of the caller's authority. What the waterfall changed is rule 4. Caps are no longer read off
the token — they are evaluated from grant rows on the node tree, so an owner can widen or narrow
one caller at one container without minting anything, and the change takes effect on the next
dispatch with no reconnect. Your action declares the same caps it always did; the refusal wording
is unchanged; and nothing about writing a plugin is different. A grant a caller does not hold at
the node in question is rule 4, in the words it always used: `<cap> capability required`.

**Reading a `refused` message.** The message is a refusal **class**, optionally followed by the
offenders it names: the class verbatim when there is nothing to name, otherwise
`"<class>: <offenders, comma-separated>"`. Real answers from a live server:

```
essential
builtin: engine.plugins
still_enabled: core.draw
unknown_plugin: core.ghost
missing_dependency: test.leaf
dependency_disabled: test.base
incompatible_dependency: test.rival
```

Switch on the prefix before `": "`; treat the remainder as identity for display, never as meaning.
The full class list is published at `GET /api/protocol` under `pluginContract.refusalReasons`, so a
client can enumerate every refusal it may have to render without reading this file.

---

## 4. Lifecycle, dormancy, and your data

Everything in this section is the behavioral contract, normative in
`docs/decisions/0013-plugin-behavioral-contract.md`, with the ratified per-kind table in
`REGISTRY.md` §Disable semantics (D4′) and its law in `AXIOMS.md` A1.

### The one rule to internalize: disable retains

Being disabled gates your ACTIVE surface and destroys nothing. Your rows, your scene elements,
your panel's leaf in every principal's layout, your section's slot, your element-type reservation
and your migration ledger all survive, and re-enabling restores them **in place**. There is no
manifest field that makes a disable erase anything, by design: erasure is
`engine.plugins.purge { id }`, a separate `plugins:manage` verb that is **refused while your plugin
is enabled** (refusal class `still_enabled`). Disable first, purge second — the first step is the
reversible one.

### The hooks

```ts
// src/server.ts
export const serverDef = {
  manifest,
  actions: [rename, kill],
  handlers: {/* … */},
  lifecycle: {
    // You were just turned ON (a transition, never boot). Put your own state in order.
    onEnable: async (ctx) => {
      await ctx.storage.set("lastEnabledAt", String(ctx.now()));
    },
    // You are being turned OFF. Flush and park — never delete user data here.
    onDisable: async (ctx) => {
      await ctx.storage.set("parked", "1");
    },
    // SOMEONE ELSE changed. Repair your own references to what left or arrived.
    onAssemblyChanged: async (ctx, delta) => {
      if (delta.disabled.includes("core.canvas")) await ctx.storage.set("parked", "1");
    },
    // You are being destroyed. The engine clears your namespace and releases your element
    // types either way; this hook is for anything only YOU know about.
    onPurge: async (ctx) => {
      await ctx.storage.delete("parked");
    },
  },
};
```

A hook receives exactly `{ pluginId, storage, now() }` and may be sync or `async` — both are awaited
under the same bound. The context is that narrow on purpose: a hook exists to order your **own**
durable state, and anything that touches the workspace is a mutation, which goes through an action
door where it can be authorized, validated, logged and observed (invariant 13). Because the
parameter is contravariant you may declare only the slice you use —
`onDisable: (ctx: { storage: PluginStorage }) => void` type-checks — the same sandbox shape action
handlers have.

- **`onAssemblyChanged` fires on every SURVIVING plugin** — enabled before AND after the change —
  in assembly order, after the roster commits and before it is broadcast, with
  `delta: { enabled, disabled }`. The plugins in the delta do not get it; they get their own
  `onEnable`/`onDisable`, so nobody is told twice about their own transition. The plugin that needs
  to repair state is usually not the plugin that was toggled, so this — not `onDisable` — is where
  you notice that a peer left.
- **These are TRANSITION hooks, not boot hooks.** At boot, everything enabled is simply live: no
  `onEnable` fan-out and no lifecycle state invented for a start nobody triggered. If you need
  "prepare on first use", do it lazily in your handlers, not in a hook that will not run.
- **Every hook is bounded at 2 seconds, and disable always completes.** If your `onDisable` throws
  or hangs, the disable still lands; your roster entry is then marked
  `lifecycle: "disable_failed"` (or `"enable_failed"`) and every principal, human or agent, sees
  it at `GET /api/plugins`. A failed teardown is a visible state, never a wedged workspace. The same
  applies to `onPurge`: failing it does not stop the purge.
- The roster also carries **`changedBy` and `changedAt`**, so the placeholder your contributions
  leave behind can say who turned you off.
- The purge action answers an exhaustive record —
  `{ id, removed: { storage, elements, ownership } }`, all three keys always present — and it does
  **not** touch documents: your element records belong to the workspace's Yjs document, and what a
  purge releases is your claim on those kinds.

### Your data: `ctx.storage` and migrations

`ctx.storage` is the only place a plugin persists anything. It is namespaced to your plugin id (you
cannot name another plugin's keys, and you never see a table name), versioned by your manifest's
`dataVersion`, retained across disable, and cleared by a purge. A plugin that writes outside it is
a plugin whose purge is a guess.

```ts
interface PluginStorage {
  readonly pluginId: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<readonly string[]>; // sorted; the engine's own `$` rows are never listed
  dataVersion(): Promise<PluginDataVersion | null>; // null until something has been stamped
  appliedMigrations(): Promise<readonly string[]>; // bare names, in application order
}
```

It is **promise-returning** and **string-valued**: serialize your own structures. Keys match
`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$` and values are ≤64 KiB; a `$` prefix is engine-reserved and
`set`/`delete` reject on it, which is what makes the version stamp and the migration ledger something
you can read but not forge. If you have more than 64 KiB of a thing, it is a document, and documents
have a plane (§5).

**One contract, every plugin.** ADR 0016 §4 (ratified, R3) made `PluginStorage` promise-returning
for every plugin, first-party included, because an isolated plugin's storage calls cross a process
boundary and two storage contracts would be two doors onto one concept (invariant 14). In-realm the
handle is synchronous inside — the SQLite call runs before the promise comes back, so `await` costs
a microtask and nothing else — and every refusal (a reserved or malformed key, an oversize value) is
a **rejection** with `PluginStorageError`, never a throw, so a `try`/`catch` around an `await` is the
one failure path whichever way your plugin runs. Write one storage call per statement and `await`
each; `storage.get(storage.get("ptr") ?? "")` no longer type-checks, which is the point.

When your stored shape changes incompatibly, bump `dataVersion.major` and ship a **named**
migration:

```ts
export const serverDef = {
  manifest, // dataVersion: { major: 2, minor: 0 }
  migrations: [
    {
      name: "2026-09-01-split-stroke-points", // the ledger records NAMES, stable under rebase
      to: { major: 2, minor: 0 }, // the version this migration produces
      migrate: async (storage) => {
        for (const key of await storage.keys("stroke:")) {
          const raw = await storage.get(key);
          if (raw !== null) await storage.set(key, rewrite(raw));
        }
      },
    },
  ],
  // …
};
```

A migration is **all-or-nothing on one condition: it awaits nothing but its storage handle.** Every
storage call settles before it returns, so a chain of awaited storage calls runs to completion in one
turn of the event loop and no dispatch — which arrives as I/O — can interleave with half a
conversion. A migration that awaits a timer, a file or the network opens exactly that window, and
must not. They run at boot for enabled plugins (awaited before the server binds its socket) and at
the enablement door for a plugin being switched on — never for a disabled one, whose data is
retained untouched and re-judged when someone turns it back on. Applied names are recorded in the
ledger, so none ever runs twice. The rules the engine applies, adopted from Home Assistant's
asymmetry:

| Stored vs. manifest `dataVersion` | Outcome                                            |
| --------------------------------- | -------------------------------------------------- |
| equal                             | compose                                            |
| minor differs, major equal        | compose anyway; no migration needed                |
| major differs, migration present  | run unapplied migrations in order, record, compose |
| major differs, no migration       | refuse to compose YOUR plugin, named reason        |
| stored major > your major         | refuse — your build is older than the data         |

A refusal here is per plugin and named on the roster; it never takes the workspace down, and it never
stops the server booting because of a plugin that is switched off.

### Element types are reserved while you are away

The engine records which plugin owns which element `type` (a workspace-level `meta` row, beside the
enablement set — not something you can write). While you are disabled your types stay yours: a
different plugin claiming one refuses composition, naming both sides. Only a purge releases them.
This is why a disabled plugin's scene records can never be silently inherited — the alternative to
"missing data" is "somebody else's plugin reading your rows", which is worse.

---

## 5. Which plane does my feature belong to?

This is the question that decides whether you write an action at all. Answer it before you
write code; getting it wrong produces state that one principal can see and another cannot,
which is the bug class the axioms exist to prevent.

| Plane               | Rule                                                                                     | Mechanism                                                      |
| ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Action**          | Legality or effect depends on state the actor cannot see, or authority it does not hold. | A registered action. `POST /api/actions/:name`.                |
| **Document**        | A per-element edit whose worst-case merge outcome a human would accept.                  | The Yjs scene document.                                        |
| **Presence**        | It dies with the connection.                                                             | The presence payload (cursor, selection, viewport, `vantage`). |
| **Channel traffic** | A continuous stream — PTY bytes, cursor motion, a live drag.                             | Existing channel frames or local echo.                         |

The continuous-stream row has a corollary you must obey: **an action fires at the commit point
of a gesture, never per frame.** Dragging a workspace divider paints locally for every pointer
move and dispatches exactly one `core.space.setLayout` on pointerup. A per-frame action is a
performance bug and a trace flood — every dispatch leaves a durable row (axiom A6), so sixty
of them per drag is sixty rows saying the same thing.

State that belongs to none of the four is **unplaned**, and unplaned state is a bug. There is
one legitimate escape: genuinely device-local presentation state (a remembered viewport, "this
browser prefers the sidebar collapsed"), which must be registered in the `REGISTRY.md`
device-local register. `verify:axioms` fails on any `localStorage` key that is not listed
there.

---

## 6. Contributions, with `core.draw` as the worked example

`core.draw` is deliberately the smallest complete plugin: it contributes one element renderer
and one tool, and it has no server half at all, because drawing a stroke is a document-plane
edit.

The web half exports the renderers, keyed by the ids the manifest declared; the shape is the
one `packages/web/src/assembly.ts` registers, so let inference type it rather than naming a
type you have not read (a maintainer-only exception to the opening promise: the shape lives in
the engine's source while the only authoring channel is in-tree, #151/#152):

```tsx
// packages/plugins/draw/src/web.tsx
import { manifest } from "./index";

export const webDef = {
  manifest,
  elements: { draw: DrawNode }, // keyed by the element `type` from contributes.elements
  tools: { draw: DrawTool }, // keyed by the tool id
};
```

The engine merges your element renderers into the canvas node-type map and your tools into the
toolbar each one NAMED (`contributes.tools[].toolbar`, defaulting to `canvas`). Nothing in the
engine mentions "draw"; disable the plugin and the tool button disappears and existing strokes
render as placeholders, live, without a reload.

### What an element renderer receives

`draw` needs nothing from its host, which makes it the smallest example and a misleading one.
`core.notes` is the sharper case — a note is edited character by character by several people at
once — and it is why the element contract is explicit rather than "whatever the canvas node happens
to pass". There are already two mount sites (a canvas node type and `ElementOutlet` for a tile
leaf), so one frame's props are deliberately NOT the contract. All three types come from
`@manifold/plugin`:

```ts
interface ElementProps {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>; // your stored record
  readonly selected?: boolean | undefined;
} // identity and record only — geometry stays engine business

interface ElementHost {
  readonly doc: ElementDocument;
  readonly editingElementId: string | null; // the host owns edit focus…
  beginEditing(elementId: string): void; // …a renderer ASKS to enter…
  endEditing(elementId: string): void; // …and asks to leave
  readonly removeWhenEmpty: boolean; // canvas: an emptied note is litter; tile leaf: it IS the occupant
}

interface ElementDocument {
  elementText(elementId: string): Y.Text | null;
  transact(fn: (tx: ElementTx) => void): void;
}
interface ElementTx {
  patch(elementId: string, patch: ScenePatch): boolean;
  remove(elementId: string): boolean;
  text(elementId: string): Y.Text | null;
}
```

Reach the host with `useElementHost()` from `@manifold/plugin/hooks`; the mount site provides it
through `ElementHostProvider`, and the hook THROWS rather than degrading, because an element with no
mount site has nowhere to commit an edit. Edit focus is host-owned because the host publishes it as
presence `view.editingElementId` (A2: what you are editing is observable), and `removeWhenEmpty` is
the one genuine disagreement between the two disciplines rather than a preference.

`ElementDocument`/`ElementTx` are the **document plane restated structurally** — the same technique
`HostServices.client` uses, so the SDK's `SessionClient` satisfies the interface without a plugin
ever importing web internals. The load-bearing point: **an element renderer edits its document
directly and declares no action at all.** A per-element edit whose worst-case merge a human accepts
is document traffic (§5), so `core.notes` and `core.draw` both ship with zero actions. If you find
yourself wanting an action for a keystroke, re-read the plane table.

**You implement nothing for dormancy, and there is no seam for it.** Both mount sites decide before
your component is ever constructed, asking the same three questions in the same order: unknown
element type → placeholder `state="unknown"`, owning plugin disabled → `"disabled"`, type declared
but no renderer registered → `"unavailable"`. Only past all three does a mount site reach your
component. So a disabled `core.notes` leaves the note's record untouched in the document and paints
the engine's named placeholder in a canvas node and a tile leaf alike — the state is also mirrored
to `data-plugin-state` for gates to assert on.

The only dormancy lever a plugin has is manifest DATA: `dormant.mode` and `dormant.label`. Silence
is a real declaration — absent ≡ `ghost`, the named placeholder — and it is the right declaration for
anything holding a user's work; `core.notes` deliberately declares no `dormant` field at all. Reach
for `hide` only for chrome, never for a node holding work: hiding a record a person typed into makes
their work invisible without deleting it, which is the one outcome worse than a placeholder.

### The other contribution kinds

- **`panels`** are leaves of the workspace tile tree. The workspace layout is itself a
  `TileLayout` whose leaf refs are `{ kind: "panel", panelId }` — the shell is a
  composition of panels (`core.shell.sidebar` and `core.shell.container-view` by default),
  rendered
  by the same `TileTree` component that renders a composition. One tree vocabulary everywhere.
- **`seats`** say where your panels ask to SIT in a workspace nobody has arranged yet. The
  engine composes that default from the enabled roster's seats — one row of leaves in `order`,
  `ratio` weighting each against its siblings — so there is no default-layout constant to edit
  and no registration file to be added to: declare a seat and your panel is in a fresh
  principal's workspace, absent one and you seat nothing. Only the DEFAULT is composed; a
  principal who has arranged their workspace keeps the tree they arranged (ADR 0017 §3).
- **`sections`** are rows in the sidebar stack, ordered by the manifest's `order` field, in one
  of two presentations — `"disclosure"` (the default: a titled, collapsible block) or
  `"plain"` (a row that draws itself end to end). There is no user-visible section-order
  setting to read and no hardcoded section list to edit; the manifests _are_ the order. `plain`
  is why the rail has no floor JSX left: the brand line, the three creators, the status line,
  the key table's opener and the identity footer are all ordinary rows now. See "Contributing a
  plain row" below.
  A row may also declare **`cluster`**, a bare word: rows that declare the SAME word paint side
  by side as one horizontal unit of the stack, placed where the cluster's earliest member sits
  in the live order. It is how `core.keys` and `core.plugins` sit together at the rail's foot —
  both declare `cluster: "utility"`, neither knows about the other, and no floor file, panel or
  registry holds a list of the members. Membership is declared rather than positional, so an
  arrangement can move a cluster but never break one apart, and a word with one live member
  paints exactly as an unclustered row does. Absent ≡ this row is its own unit, so a manifest
  written before the field existed composes identically. The word is `cluster` and not `group`:
  `group` is the placement algebra's capability set, and one concept per word is the law
  (`REGISTRY.md` §Lexicon).
  A row may also declare **`setting`**, naming one of your OWN
  `contributes.settings` ids: while that value reads false for the reader, the row is DROPPED
  from their sidebar. Assembly refuses a `setting` your manifest does not contribute, naming
  both, and a row may never name another plugin's — a preference of theirs erasing a row of
  yours is exactly the shadowing D5 refuses one level up. Absent ≡ unconditional.
- **`settings`** declare `{ id, title, kind, default, scope? }`. Kinds are `boolean` (a switch)
  and `enum` (a select). An enum adds `values: [{ id, title }]`: one to 32 choices with unique,
  non-empty ids; `default` must name one. Invalid choices refuse manifest admission with
  `invalid_setting_enum`. For example, `{ id: "storage", title: "Storage", kind: "enum",
values: [{ id: "local", title: "Local" }, { id: "external", title: "External" }],
default: "local", scope: "workspace" }`.
  Omitted scope means `principal`: server-saved preferences follow the reader across devices.
  `workspace` means one shared value for everyone; writing it requires `plugins:manage`.
  The generic pane names this scope in words and disables writes with the refusal when the
  reader lacks authority. Write through `engine.plugins.setSetting { plugin, setting, value }`
  (`value: null` retracts, so the row reads your `default` again) and then call
  `host.assembly.refreshSettings()`; READ them off `host.assembly.settings`, or with
  `settingValue(host.assembly.settings, myId, "thing") !== false` when your row gates part of
  ITSELF rather than the whole row — the engine drops rows, and what is inside one is yours.
  Never spell your own default at the read: it lives in the manifest, and a second copy goes
  stale the moment you change the first. Absent ≡ you declare no preferences, and your manifest
  serializes exactly as it did before the field existed.
  Workspace changes emit the declared `plugin_setting_changed` event on
  `manifold://plugin/engine.plugins`; connected clients re-read the same settings endpoint.
- **`tools`** are buttons in a toolbar, and **`toolbar`** says WHICH one: `canvas` is the
  freeform discipline's tool strip, `arrange` is `core.arrange`'s floating F8 editor over the
  workspace itself. The vocabulary is the engine's and closed (`toolbars` in
  `GET /api/protocol`'s `vocabulary`); the tools inside a bar are yours. Absent ≡ `canvas`,
  which is what every row written before the field existed means — the only bar there was.
  A bar paints exactly the enabled tools that named it, so two plugins may both contribute a
  `select` into DIFFERENT bars without colliding (D5 still refuses two plugins claiming one id
  within one bar), and a tool naming a bar this screen does not draw is simply not painted
  rather than leaking into somebody else's strip.
  A tool is not always a BUTTON. Some of `core.arrange`'s own rows are painted as a
  **palette** — carry sources you drag structure out of and drop into a tree — and that is
  core.arrange's own reading of its own `contributes.tools`, decided inside the plugin that
  draws the bar. There is no manifest field for it and there is not going to be one: a bar's
  owner already decides how the rows that named it are painted, exactly as the canvas bar
  decides its rows are mode buttons.
- **`events`** are the event kinds you originate — the vocabulary half of the event plane, whose
  authoring rules are §6b.
- **`routes`** are the URL spaces you claim, one bare path segment each: `{ segment: "uri",
title: "Deep links" }` is `core.uri` saying it answers on `/uri/<rest>`. There is ONE URL
  space, so a segment is claimed globally and two manifests wanting one are refused with both
  names (D5) — the claim is the vocabulary, and your web half only says who DRAWS it (§7).
  A segment you declared and did not register renders the engine's named placeholder; a
  component for a segment you never declared renders nothing at all, exactly as a smuggled
  panel does. Absent ≡ you answer on no path of your own.
- **`bindings`** are the keys you answer to. The one contribution kind with no manifest row: the
  declaration and its handler are the same object, registered by your WEB half, so §7 specifies
  it beside the other web channels.

### Host services

A panel or section component receives exactly one prop:

```ts
interface PanelProps {
  host: HostServices;
}
interface SectionProps {
  host: HostServices;
}

interface HostServices {
  readonly client: SessionHandle; // the SDK doors: action(), place(), selfCaps(), machines(),
  // index(), attendanceByContainer(), terminalsByContainer(), allTerminals(),
  // resolve(uri) — what a manifold:// address names right now: its canonical
  // spelling, its structured ref, whether the node exists, and its title. Parsing
  // an address is local (`parseManifoldUri`); whether it still names anything is
  // this door, and a plugin that PRODUCES an address should check the one it shows.
  // And the terminal surface — see "Terminals through the handle" below.
  readonly principal: Principal; // who this device is — paint in this principal's colour
  readonly token: string; // this device's bearer: the grant a CONTAINER RENDERER opens its own
  // room pipe with, and nothing else — never a client minted in a panel (#196)
  readonly containerId: string | null; // the container the route is showing, null at the root
  navigate(uri: string): void; // a manifold:// URI, or an app path
  readonly viewport: ViewportHandle | null; // null until a container renderer is mounted
  readonly authoring: AuthoringHandle | null; // null when nothing can be authored into
  readonly assembly: AssemblyFacet; // read the composition: see below
}

interface AssemblyFacet {
  roster(): PluginRoster; // which plugins exist, and what each declares
  enabled(id: string): boolean; // false for a disabled plugin AND for an unknown id
  pluginTitle(id: string): string | null; // the owner's human title, for placeholders and tables
  readonly sections: readonly ComposedSection[]; // every declared sidebar row, in declared order
  readonly bindings: readonly ComposedBinding[]; // the composed key table, sorted by key
}

interface ViewportHandle {
  centerOn(uri: string): void;
  viewport(): { x: number; y: number; zoom: number } | null;
}
```

`assembly` is READ-ONLY and it is the same surface for everybody — the plugin manager listing the
roster and the shell's own sidebar panel drawing the section stack open the identical door. There
are no setters on it: changing the assembly is an action (`engine.plugins.setEnabled`), like every
other authority-bearing change. Nothing in it names a favourite plugin, which is what lets a
stranger's replacement for the workspace shell read exactly what `core.shell` reads.

`sections` is ONE registry in ONE order. A row carries `presentation` — `"disclosure"` for a
collapsible section with a header, `"plain"` for a row that draws itself end to end — and both
kinds interleave by declared `order`, so arrange mode, the per-principal arrangement and the
owner-naming DOM never ask which kind a row is; only the component filling it does. A row whose
owner is disabled is PRESENT with `enabled: false` rather than dropped, because a stored
arrangement must not forget a seat while its plugin is off (D4′). What a row does NOT carry is a
component: rendering somebody else's row goes through `SectionOutlet` from `@manifold/plugin/hooks`,
which paints the engine's named placeholder when nothing is registered.

```tsx
import { SectionOutlet } from "@manifold/plugin/hooks";

for (const row of host.assembly.sections.filter((row) => row.enabled)) {
  // row.title, row.plugin, row.order, row.presentation are yours to lay out
  <SectionOutlet id={row.id} host={host} />;
}
```

#### Terminals through the handle

A terminal is channel traffic — its birth is a round trip to a machine and its bytes are a
stream — and `host.client` carries the whole of it, so a plugin that opens, drives or watches a
terminal does it through the handle it was given and never by building a `SessionClient` from
`host.token` (issue #196; ADR 0016 §3 withdraws the token from an isolated plugin, and what is
on the handle is what its RPC will carry):

```ts
interface SessionHandle {
  // … the doors above …
  readonly terminals: ReadonlyMap<string, TerminalInfo>; // the routed room's table, live
  openTerminal(opts: {
    elementId: string; // your correlation token; under `placement: "tile"` the server places
    cols: number;
    rows: number;
    cwd?: string;
    machineId?: string;
    placement?: "tile";
    program?: TerminalProgram; // exec this instead of the shell (#192)
    env?: TerminalEnv; // merged under the fixed MANIFOLD_* keys
    timeoutMs?: number;
  }): Promise<TerminalInfo>;
  attachTerminal(terminalId: string): void; // snapshot + gap-free outputs; refcounted
  detachTerminal(terminalId: string): void;
  sendTerminalInput(terminalId: string, data: string | Uint8Array): void; // controller only
  resizeTerminal(terminalId: string, cols: number, rows: number): void; // controller only
  takeTerminal(terminalId: string): void; // core.terminals.take decides
  killTerminal(terminalId: string): void; // core.terminals.kill decides
  on(event: "terminals_changed", fn: () => void): () => void;
  on(event: "terminal_snapshot", fn: (message: TerminalSnapshot) => void): () => void;
  on(event: "terminal_output", fn: (message: TerminalOutput) => void): () => void;
  on(event: "terminal_event", fn: (message: TerminalEvent) => void): () => void;
  on(event: "error", fn: (message: ErrorMessage) => void): () => void; // `not_controller` lands here
}
```

Which ROOM a verb rides is the host's decision, not yours, and it is worth knowing because it
decides when a call can succeed. The host's own channel only WATCHES the routed room (it is a
spectator, so the renderer stays the one occupant avatar), and the server refuses every terminal
mutation on a spectator. So the host routes each MUTATION through the occupant pipe of the
container it concerns — the pipe the mounted container renderer dialed with `host.token` and
published: `openTerminal` is born in `host.containerId`, the container the viewer is looking at,
and a terminal-keyed verb (`sendTerminalInput`, `resizeTerminal`, `takeTerminal`, `killTerminal`)
rides the pipe of the room whose table holds the terminal. When no such view is mounted the
call throws an `Error` naming what is missing (`no occupant view of container <id> is mounted`,
`no occupant view holds terminal <id>`, `no container is open` at the workspace root) instead
of sending a frame the server would refuse: a panel offers "open a terminal here" exactly when
`host.containerId` is non-null and a container view is on screen. The reads — `terminals`,
`attachTerminal`/`detachTerminal` and the subscriptions — answer for the routed room. A panel
that opens a terminal and types into it is therefore:

```ts
const born = await host.client.openTerminal({
  elementId: crypto.randomUUID(),
  placement: "tile",
  cols: 80,
  rows: 24,
  machineId: machine.id,
});
host.client.sendTerminalInput(born.id, "code launch --selection ...\n");
```

The opener holds the controller lease, so the input is forwarded; anyone else's lands as an
`error` frame with code `not_controller` and `ref` naming the terminal. A CONTAINER RENDERER is
the one contribution that dials a room of its own (A4: resolve the reference, open a pipe with a
grant, project it), and it publishes that pipe with `useRoomPipeRegistration` from
`@manifold/plugin/hooks` on mount so the routing above has something to route through — the
shipped canvas and composition renderers are the worked examples.

### Mounted location and shared titlebars

The engine's `NodeTitleBar` is the existing shared UI primitive, **not a titlebar plugin**.
Renderers own their chrome and invite contributions into its slots. Import `ProjectionScope`,
`ProjectionScopeProvider`, `useProjectionScope`, `extendProjectionScope`, `usePublishLocation`,
`publishLocation`, and `TitlebarOutlet` from `@manifold/plugin/hooks`:

- Create a root `ProjectionScope { host, client, locationPath }` using the routed attendance
  client and `[{ kind: "container", containerId: rootId }]`. Keep that SAME root client in
  every descendant scope, even when a nested renderer registers its own room pipe.
- At each mount boundary, extend the scope with the actual containing `element` or `tile` ref
  and then the target ref. Wrap descendants in `<ProjectionScopeProvider value={scope}>`.
  Never derive a canonical parent from the index: two portals to one target are two locations.
  Unknown/overlong paths stay unknown; do not truncate them to create a false ancestor match.
- Call the callback returned by `usePublishLocation(scope?)` on engagement/focus, not during
  render. The hook defaults to inherited scope. On disengagement publish the enclosing path;
  on route teardown publish `null` with `publishLocation`. Equivalent paths are compared
  structurally, so fresh arrays do not echo. Root vantage publication is independent of
  whether any presence painter is enabled; preserve legacy `focus.elementId` sends.
- Place `<TitlebarOutlet scope={scope} />` in `NodeTitleBar.middle`. The optional scope
  defaults to inherited context. It reads the existing `overlays.titlebar` registration;
  missing/disabled contributions or unknown scope paint nothing, without a wrapper.
  `core.presence` derives compact attendance from per-connection mounted paths, deduplicates
  principals and retains its roster popover in the browser's top layer so tile and titlebar
  clipping cannot hide its details. Do not add renderer-specific avatars or infer a remote
  path from the principal's aggregate vantage. `container-spotlight` remains separate.

Both `TerminalRendererProps` and `ContainerRendererProps` expose `projectionScope?`,
`frame?: "window" | "tile"`, `titlebarMiddle?`, `titlebarExtras?`, and `titlebarDragProps?`.
Forward these to the occupant's own shared bar, not a second host-rendered bar. The middle
slot hosts attendance; extra actions host native terminal font controls. `NodeTitleBar` maps
`extraActions` to its action area and accepts `dragProps?: TitlebarDragProps` from
`@manifold/plugin/ui`: `draggable?` and native div `onDragStart`/`onDrag`/`onDragEnd` handlers.
Opting in marks the whole bar with `data-titlebar-draggable`; `draggable: false` supports an
external pointer transport. Interactive descendants, rename input and selected title text
remain protected from host dragging. No separate visible grip is needed.

`frame` defaults to `window`: rounded exterior chrome. Use `tile` for internal occupants:
square seams and matching backing, with the terminal plugin owning its own frame/xterm CSS.
Portal composition chrome and terminal typography use the same native scale as mono
windows; only canvas zoom scales the whole projection. Spectator fitting changes its
display, never the shared PTY geometry.
Do not reach into another plugin's CSS families to mask corners. Keep the live content host
stable: tile preview and authoritative FLIP settlement transform `tile-content-host`, never
both a pane ancestor and its content. Pass `useTileDeparture(containerId, overrides)` from
`@manifold/plugin/ui` to `TilePreviewOverlay.departure`. It reactively reads the shared local
carry register, preferring a local matching tile over the freshest source-matching remote
override even without an aim; incoming target arbitration wins. Portals combine canvas and
own-room overrides only at this overlay leaf, not in their live content host. Clear on
end/expiry, and keep `TileTree` mounted for an empty layout while its bounded departure shell
finishes. Portal body clicks engage through capture without a covering shield, leaving native
occupant titlebar controls reachable.

The existing session gesture relay also reaches a tile carry's source composition when the
native drag streams through its enclosing canvas, with or without a target aim. Source and
aim rooms each require the sender's `containers:read` authority and must already be resident;
shared recipients receive one frame. These cross-room frames retain `aimOnly`, which forbids
painting their foreign canvas geometry. The same projection memory delivers releases to
previous source/aim rooms even when the end frame omits the carry.

That is the whole host contract, and it is deliberate: no store, no room map, no React context
from `packages/web`, nothing that would have to be re-plumbed if plugin code were later moved
behind an isolation boundary. If you need data the host does not expose, add a typed wrapper to
the SDK — never a direct `fetch` against a route, and never a deep import.

**When a plugin and the floor must both touch one value, the slot lives in `@manifold/plugin`.**
Neither side may import the other (`REGISTRY.md` §Foundation), so a value with a writer on one side
and a reader on the other has exactly one legal home: the engine package both already depend on.
The shipped example is the spotlight — `core.presence` applies one and calls `recordSpotlight(uri)`;
the web floor's debug probe reads `lastSpotlight()` for the axioms gate. One mutable slot, because
"what did this viewport actually do" has one answer per device, and it records where the camera
MOVED rather than where a frame arrived, so a spotlight the viewer has switched off never lands.
Reach for this only for that shape — a single cross-boundary fact, not plugin state, which belongs
in `ctx.storage` or the document.

Addressing: `manifold://` URIs are the canonical way to refer to anything —
`manifold://container/<containerId>`, `.../element/<elementId>`, `.../tile/<tileId>`,
`manifold://terminal/<terminalId>`, `manifold://principal/<id>`, `manifold://plugin/<pluginId>`,
`manifold://action/<actionName>`. `GET /api/resolve?uri=` tells you whether one exists and what
it is called; `/uri/<encoded>` is a deep link to it. Use these instead of inventing an id
format.

### Contributing a plain row

A `plain` row is the shape for anything in the rail that is not a collapsible block: a creator,
a status line, a footer. It is an ORDINARY contribution — same registry, same per-principal
arrangement, same D4′ placeholder — and the only difference from a disclosure section is that
the stack wraps it in nothing and it draws itself end to end. Three pieces, and the third is
one line:

```ts
// 1. the manifest row: `presentation` says how it draws, `order` says where it sits
contributes: {
  sections: [{ id: "new-canvas", title: "New canvas", order: 2, presentation: "plain" }],
}
```

```tsx
// 2. the component — reached like any other section, so it takes `SectionProps`
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { ControlIcon } from "@manifold/plugin/ui";

export function NewCanvasRow() {
  // The rail's WIDTH is the host's fact, and the one thing a row usually needs from it:
  // collapsed to icons there is no room for a label. Read it here — never keep a second copy.
  const { createContainer, creating, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  return (
    <button
      className="sidebar-new"
      type="button"
      data-action="core.index.createContainer"
      title="New canvas"
      aria-label="New canvas"
      onClick={() => {
        if (!sidebarOpen) setSidebarOpen(true);
        createContainer("canvas");
      }}
      disabled={creating}
    >
      <ControlIcon kind="add" />
      {sidebarOpen ? <span>New canvas</span> : null}
    </button>
  );
}
```

```ts
// 3. the registration, in the web package's assembly.ts — the same map a disclosure uses
export const canvasWebPlugin = { id: "core.canvas", sections: { "new-canvas": NewCanvasRow } };
```

Four rules the shipped rows follow, and the reasons:

- **Own your own state.** A row that opens a form (`core.index.new-folder`) or a modal
  (`core.shell.brand`'s changelog, `core.shell.keys`' key table) holds that state itself and
  portals the dialog to `document.body`. The rail is a narrow, clipping, scrolling box; a
  dialog inside it would be laid out by it.
- **Render nothing when you have nothing.** `core.shell.status` returns `null` with no
  container mounted and on a collapsed rail. A plain row that draws nothing is legitimate; its
  seat in the arrangement is unaffected.
- **Ask the host for the rail's width, once.** `useWorkspaceShell` is the ONE channel for
  `sidebarOpen` and for the creation doors (a birth also has to be remembered on this device,
  refresh the index and land the viewer inside it). A second channel would be a second answer.
- **Do not decide the rail's geometry.** The collapse control is the panel's, not a row's: a
  contribution that resized its own container could be disabled while the rail is collapsed,
  and nothing would be left to expand it.

Motion is free and not yours to write: the stack plays a FLIP whenever the visible order
changes — your row being enabled, disabled, nudged or dragged — from `useFlipStack` in
`@manifold/plugin/ui`, and it is off entirely under `prefers-reduced-motion: reduce`. Do not add
a `transition` to a row; it would fight the transform.

### Marking your affordances

Every DOM control that invokes an action carries the action's full name:

```tsx
<button data-action="core.terminals.kill" onClick={…}>Kill</button>
```

This is not decoration. It is what lets a test, an agent, or a reviewer answer "what can this
pixel do?" without reading the handler, and the gate checks that every `data-action` literal
in the tree names an assembled action.

---

## 6b. Events: telling the workspace something happened

The fourth plane (ADR 0012). Use it when something happened that another plugin wants to know
about and nobody is editing anything: a container created, a machine enrolled, a terminal gone.
It is not for continuous streams (PTY bytes, cursor motion, live drags — those are channel
traffic), and it is not a way to change the world.

**You declare; the engine emits.** Your manifest names the kinds you originate; the emission
happens at the door your action already goes through. There is no publish API you can reach from
anywhere in your code, which is the whole reason the plane cannot become a second mutation path.

```ts
// src/index.ts — the vocabulary
contributes: {
  events: [
    { id: "container_created", title: "Container created" },
    { id: "container_renamed", title: "Container renamed" },
  ],
}
```

```ts
// src/server.ts — the emission, inside the handler that committed the change
const TOPIC = { kind: "plugin", pluginId: indexManifest.id } as const;

async createContainer(ctx, args) {
  const container = { id: ctx.newId(), name: args.name, createdAt: ctx.now() };
  ctx.store.createContainer(container);
  ctx.emit(TOPIC, "container_created", { containerId: container.id, name: container.name });
  return { container };
}
```

Five rules, and they are all mechanized:

- **A kind is `snake_case`, global, and owned by one plugin.** `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`,
  max 48 characters. It is never qualified by your id — `container_created` says WHAT happened
  and the topic says to WHOM, so a subscriber's match does not depend on which plugin currently
  implements the concept. Two manifests declaring one kind is an `AssemblyError`, and emitting a
  kind you did not declare is refused by name.
- **`ctx.emit` takes a REF, never a string.** `formatManifoldUri` is the one joiner in the tree,
  so the address is compiler-joined and there is no topic-string namespace to police.
- **Address the most specific node that exists both before AND after the event.** When the
  subject is being created or destroyed, or has no `manifold://` form at all (a folder),
  that node is your COLLECTION: `manifold://plugin/<your id>`, built from your own
  manifest id so the address and the declaration cannot drift. The engine refuses an emission on
  another plugin's node. A collection topic is also what makes a client's whole feed one
  subscription instead of one per row.
- **Emission is STAGED.** `ctx.emit` buffers; the buffer flushes only after your handler returned
  successfully and its declared result schema parsed. A handler that mutates and then refuses,
  throws, or fails its own schema publishes nothing — refusals are not events, and you do not
  have to remember that.
- **In-realm `ctx.target(ref)` names a trace target without emitting news.** Use it when
  the action has no event-plane announcement, as `core.machines.revoke` does. Emission refs
  already enter the same deduplicated target set; do not name them twice. Targets survive
  handler refusals and failures in the trace, while events still publish only on success.
- **The payload is a hint, not the state.** Flat and bounded, the same discipline an element
  payload carries. It exists so a subscriber can decide whether to re-read, not so it can skip
  the read; a receiver acting on shipped state instead of reading it back through a door is how a
  notification plane turns into a replication plane nobody arbitrates.

**Consuming.** From an SDK client, `client.subscribe(topics, handler)` returns its own
unsubscribe; declarations are refcounted onto the socket, so two panels watching one node cost
one `subscribe` and neither cancels the other. In the browser, do not hand-roll a listener: pass
`topics` (and the event kinds you care about) to the shared feed
(`usePolledResource`, `@manifold/plugin/hooks`) and keep your one fetch function. The feed reads
once at mount, then once per burst of matching events, content-compares the answer so an
unchanged one re-renders nobody, and falls back to a cadence in exactly two states — the socket
is down, or the feed named no topics at all (the roomless workspace root). A timer never runs
beside a live subscription.

**What you may not do.** No request/response over events, no "command topics", no handler whose
contract is "publish here to make something happen" — if it changes the world it is an action.
And there are no offsets, acknowledgements or replay: an event reaches the sockets subscribed at
the instant of emission, and catch-up is reading state. Subscribing is a READ of the topic's
node, checked with the same authority `GET /api/resolve` uses, so a container-scoped token cannot
subscribe to a collection — a node with no container above it is in nobody's subtree — and the
refusal is silent by design rather than a per-topic answer that would make the plane a permission
oracle.

---

## 7. Assembly rules

Assembly happens at boot and on every enable/disable, on both the server and the web side.
It either produces a roster or throws an `AssemblyError` naming every offender. The word is
deliberate: **assembly** is the plugin-roster join, while a **composition** is a container whose
discipline is tiled. One word per concept (`AXIOMS.md` §Lexicon law, `REGISTRY.md` §Lexicon).

- **Collisions refuse; nothing ever shadows.** Duplicate plugin ids, action full names, panel
  ids, element types, tool ids, binding ids or binding KEYS fail assembly loudly. There is no
  last-write-wins, no load-order precedence, and no silent override — a shadowed capability name
  is an authority bypass, so the answer is always a refusal that names both sides.
- **Action caps must be a subset of manifest capabilities**, checked at assembly, not at
  dispatch.
- **Enable/disable is hot, workspace-global, and an ENGINE door.**
  `engine.plugins.setEnabled` (cap `plugins:manage`) is a **builtin roster row**
  (`source: "builtin"`), not a plugin action: it flips a server-persisted flag and broadcasts the
  new roster on a connection-level session frame, and every client rebuilds live. No reload, ever.
  The door lives outside the assembly on purpose — a door that can disable itself could never be
  relied on to re-enable anything. `core.plugins` is the manager **UI** only, and it is an ordinary,
  disableable plugin.
- **Disabled and unknown contributions render inert placeholders that name the plugin** — on
  canvases and in the workspace tree alike, unless the manifest declared `dormant.mode: "hide"`.
  A placeholder in the workspace tree carries a remove control that commits the pruned layout.
  Disabling a plugin must never brick a renderer, and layout writes referencing an unknown panel
  are _accepted_ for exactly this reason.
- **Disabling kills creation and administration, never cleanup.** Disabling `core.terminals`
  refuses new terminal opens and its administrative actions, but existing terminals stay
  attachable and killable. Users are never locked out of removing things.
- **Dependencies are resolved at assembly**, and the resulting order — topological, ties broken
  by id — is the order lifecycle hooks fire in. Missing `required` dependencies, `incompatible`
  peers, cycles, data-version mismatches and element-type squatting are all named refusals, never
  warnings.
- **A three-segment id without its proof is refused.** `example.notes.tags` claims a home under
  `example.notes`; a manifest that says so without `dependencies: { "example.notes": { type: "required" } }`
  fails assembly as `orphan_child`, naming the plugin and the parent (§1). It sits with the
  duplicates, squats and cycles — a structural fact no toggle can change, so it is NOT one of the
  door's refusal classes. Ratified, not yet enforced: the check lands with
  [#261](https://github.com/atyrode/manifold/issues/261); write the edge now.

### Three orthogonal facts about a plugin

Three words get conflated constantly — a "core plugin", a "builtin", an "essential" one — and they
are three INDEPENDENT facts, each with its own owner, its own enforcement and its own consequence.
A row can carry any combination; none of them implies another.

| Fact                      | Question it answers                          | Who decides                                                                                   | What it changes                                                                                                          | Enforced by                                                                                             |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `source`                  | who REGISTERED this row: engine or assembly? | the registrant, never the manifest — `builtin` is DERIVED from what the host itself registers | a `builtin` row has no toggle: `setEnabled` against it is `refused`/`builtin`                                            | `engine.` is reserved; assembly refuses a non-builtin id under it                                       |
| `essential`               | can an administrator turn this one off?      | the manifest declares it; the engine enforces it                                              | `setEnabled(false)` is `refused`/`essential`; the row still composes, dispatches and purges like any other               | the named refusal class `essential`                                                                     |
| the namespace of the `id` | WHO WROTE IT                                 | the author, bounded by the reservation: `core.` is manifold's own, `engine.` is the engine's  | NOTHING. No engine branch reads a prefix to decide what a row may do — a `core.` action is checked exactly as `acme.` is | assembly refuses a `core.` manifest the shipped distribution did not register (`CORE_NAMESPACE_PREFIX`) |

Read the rows the other way round and each one names a squat it refuses:

- **`engine.*` is the engine's.** A plugin publishing `engine.anything` would publish a row a
  client draws WITHOUT a toggle, so the assembly refuses it by name. The builtin set is derived
  from what the host registered, never claimed by a manifest — a manifest cannot make itself a
  door.
- **`core.*` is manifold's authorship, and it is the one thing that prefix buys.** It carries zero
  privilege by design; what it must not carry is a stranger. A manifest under `core.` that the
  shipped distribution never registered fails assembly naming the squatter, because an id is what a
  principal reads on the roster and what an agent reads over `GET /api/plugins` — "looks official"
  is the only authority a namespace could confer, and it is the one being defended. The permitted
  set is DERIVED from the distribution's own registration table
  (`SHIPPED_PLUGIN_IDS` in `packages/server/src/assembly.ts`, handed to assembly as
  `AssemblyEnv.distribution`); there is no hand-kept list of "our" plugins anywhere, so shipping a
  new one is a row in that table and nothing else.
- **Your own namespace is yours.** `example.notes` needs no registration anywhere, collides with
  nobody, and gets exactly the same dispatch, authority, disable, dormancy and purge treatment
  `core.notes` gets. If you find a rule that treats a `core.` row better, that is a bug worth an
  issue: it is the claim this table exists to keep checkable.

`GET /api/protocol` publishes both prefixes (`engineNamespace`, `coreNamespace`), so an author
choosing an id learns which two are taken without reading this file.

### Installing a plugin

Everything above is the in-tree channel: a package in this repository, registered by a maintainer.
A plugin that is NOT compiled into the build is INSTALLED instead (ADR 0016 §8 stage 2), from a
bundle — one JSON file, `<id>.manifold-plugin.json`, whose shape and authoring kit §Isolated
target describes. Its roster row is `source: "plugin"` like any assembled row, and carries one
block no first-party row has: `install`, what the installer consented to.

Two doors on the engine's own row, and both are **root only** (`caps: ["*"]`): `plugins:manage`
lets a principal decide which of the shipped plugins are on; installing admits code nobody in this
build wrote, and a manager token that could do that would be `*` by another name.

```
engine.plugins.install   { source, sha256, grant?, replace? }  → { id, version, grantedCaps }
engine.plugins.uninstall { id, purge? }                        → {}
```

- **`source`** is an `https://` URL (fetched with a 30 s bound, at most
  `ISOLATE_MAX_ARTIFACT_BYTES`), or an absolute path under `<data>/plugin-uploads/` — the
  operator's drop box. `MANIFOLD_PLUGIN_DEV_PATHS=1` accepts a path anywhere on the host, for
  development only.
- **`sha256`** is the hash of the bundle's EXACT bytes, and it is what you are consenting to:
  nothing is written unless the bytes read hash to it (`hash_mismatch`), and every boot re-hashes
  the stored bundle — a bundle that no longer matches is refused by name on its row
  (`enabled: true`, `lifecycle: "enable_failed"`, `install.refusal: "hash_mismatch"` — the triple
  a manager reads as "Refused") and nothing from it is loaded. The row still publishes the doors
  it had when it was admitted (the engine recorded them on the install row, never the file), and
  each one answers `unavailable` with `bundle failed verification at boot: hash_mismatch`, traced
  like any refusal, rather than vanishing into `unknown_action`.
- **`grant`** widens the DEFAULT grant, which is the manifest's declared `capabilities` minus
  `*`, `tokens:mint` and `plugins:manage` — a stranger's plugin never holds those unless an
  installer names them. The grant is published on the row (`install.grantedCaps`) and enforced at
  rung 4 BEFORE the caller's own caps: a door needing a cap the installer withheld is `forbidden`
  with `<cap> not granted to plugin <id>`, whoever asked.
- **`replace: true`** upgrades an id already installed at another hash; like `uninstall`, it needs
  the row switched OFF first (`still_enabled`).

Refusals answer `{ refused: "<class>: detail" }` with a class from `PLUGIN_INSTALL_REFUSALS`
(`artifact_unreadable`, `artifact_invalid`, `hash_mismatch`, `already_installed`,
`not_installed`, `namespace_reserved`, `still_enabled`, `storage_retained`, `no_entry`), class
first so a client switches on the prefix. An assembly refusal — a duplicate id or action name, a
`core.` squat — is caught at the door as `artifact_invalid` naming the problem and rolled back
(files, child), so an install can never be the reason a server does not boot. Uninstall removes
the row and the files and never destroys the plugin's storage on its own: while that storage
holds anything it refuses `storage_retained: <n> keys; purge first or pass purge: true`, and
`purge: true` runs the purge verb first — the same path, the same `plugin_purged` event — and the
uninstall second, so no uninstalled id ever leaves data where no door reaches it (#233). Data
outlives a DISABLE, never an uninstall: destruction is `purge`, and an uninstall is only ever
reached through it or with nothing to destroy. Uninstall also takes the row's switch with it: a
fresh install of the same id is a fresh row, on by default and attributed to nobody, whatever the
toggle said before — exactly like the first install.

The plugin manager (`core.plugins`, issue #239) is one UI over these two doors and the three
beside them. Its list is three collapsible bands — **Installed** (rows carrying `install`, grouped
by publisher), **Built-in** (`core.*`) and **Engine** (builtin rows, not toggleable) — and a plugin
FAMILY (ADR 0023: a three-segment id whose parent is composed and declared `required`) is one row
with a chevron, its parts nested under it, the parent's switch being the family's. Every row wears
a STATUS chip in plain words (On / Off / Starting / Crashed / Refused / Not ready, with the reason on
hover — never a refusal class) and a PERMISSIONS chip counting what the row holds (for an installed
row, its grant; the sheet greys what the installer withheld). Pressing a row opens a detail sheet:
status, permissions with each cap's meaning, doors, contributions, family, relations (as links),
settings, and a danger zone holding purge and — for an installed row that is off — uninstall. The
Installed band's heading carries "Install from bundle", the form (`data-action="engine.plugins.install"`)
showing the default subtraction as three chips an installer may press to grant. Sort (name / status /
recently changed / permissions), filter chips (On, Off, Needs attention, Installed, Built-in) and a
search over title, id, description and door names narrow one list; which bands are folded is
device-local (`manifold:plugin-manager-collapsed`).

### The web registration channels

A plugin's web half registers through six channels, and every one of them refuses a duplicate
by name. Two get their own subsection below — **bindings** and **workspace overlays**; here is
what all six are keyed by, and which of them the manifest declares:

| Channel               | Keyed by                                                                  | Manifest row                         |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| **renderers**         | a container DISCIPLINE declared by the plugin                          | **`contributes.disciplines`** (§2)   |
| **overlays**          | a mounted overlay SLOT (`titlebar`, `container-spotlight`)                | no                                   |
| **workspaceOverlays** | a workspace overlay SLOT (`commands`, `inspector`, `toolbar`)             | no                                   |
| **terminal facet**    | nothing: one viewer per workspace, published for other renderers to mount | no                                   |
| **bindings**          | a KEYSTROKE (`F6`, `Mod+k`), claimed globally                             | no — declaration IS the registration |
| **routes**            | a path SEGMENT you invent (`uri` serves `/uri/<rest>`)                    | **`contributes.routes`**             |

**`renderers` and `routes` have manifest counterparts.** A discipline declaration carries the
placement rules for the container your renderer draws (§2); the shipped
[`core.compositions`](../packages/plugins/compositions/src/index.ts) is the worked example.
Overlay slots and the terminal facet remain engine-owned vocabularies rather than workspace refs.
A path segment is a name its author invents in a space every plugin shares, which is why it is
`contributes.routes` (§6) and why the browser's route table is keyed off the CLAIM rather than
off whatever a web half exported. Declaring it lets the roster publish the paths a build answers
on, and a registration for an undeclared segment contributes nothing.

**A duplicate on any of the six is a refusal naming both offenders** — the four projection
channels and routes in `buildBrowserAssembly` (`packages/web/src/plugin-host.tsx`), bindings in
`composeBindings` — in the same sentence assembly uses for a duplicate section or element type:
`duplicate overlay "titlebar" claimed by: core.presence, acme.presence`.
Claims are collected over the whole roster, disabled plugins included, so turning a plugin off
can never mask a collision that turning it back on would resurrect. Until wave F the second
registrant silently won by roster order, which made the owner of a discipline, a slot, a path or
the terminal viewer a function of composition order (issue #112).

Read `packages/web/src/assembly.ts` and `packages/plugin/src/projection.ts` for the shapes — the
second maintainer-only exception to the opening promise, for the same reason as §6's.

**workspace overlays** — chrome with no container to hang on:

```ts
// src/web.tsx
export const acmeWebPlugin = {
  id: "example.notes",
  // WORKSPACE_OVERLAY_SLOTS is the closed vocabulary; the key type is the slot union, never
  // `string`, because an unregistered slot paints NOTHING and a typo would compile clean.
  workspaceOverlays: { inspector: MyChrome },
};

function MyChrome({ host }: WorkspaceOverlayProps) {
  /* `host` is the only prop: an overlay over the WORKSPACE has no container to be about, and
     the routed one is already `host.containerId`. */
}
```

The same kind as a container overlay, one host up. Use it when your chrome genuinely cannot be
scoped to a container: `core.debug`'s inspector chip follows the pointer across the sidebar rail
and the workspace frame alike, `core.arrange`'s toolbar is about the arrangement of the
workspace rather than about anything inside a room, and `core.commands`' surface is opened by a
keystroke rather than by anything on screen — including at the workspace root, where no
container is mounted and a container slot therefore does not exist. Everything else belongs in
a container's slot, a panel or a section.

The outlets are mounted once, above the route switch, so your overlay outlives the routed shell
and sits outside the subtree the sidebar's collapse can unmount. Absence paints NOTHING — no
placeholder — because an inert box floating over somebody's workspace is worse than the missing
decoration, which is also what makes disabling your plugin remove your chrome entirely. Paint
`position: fixed` and keep the layer `pointer-events: none` unless your chrome is genuinely
interactive: an overlay that swallows clicks is an overlay that changes what it decorates.

**routes** — the URL space you claimed, drawn:

```ts
// src/index.ts — the CLAIM (see §6)
contributes: {
  routes: [{ segment: "notes", title: "Notes links" }];
}

// src/web.tsx — who draws it, keyed by the segment you claimed
export const acmeWebPlugin = {
  id: "example.notes",
  routes: { notes: NotesRoute },
};

function NotesRoute({ rest, host }: { rest: string; host: HostServices }) {
  /* `rest` is the path after your segment, verbatim and undecoded: `/notes/a/b` gives "a/b".
     The engine resolved nothing inside it — that space is yours. */
}
```

Two halves, like a panel: the manifest says the path exists, the registration says who paints
it. A claimed segment nobody registered paints the engine's `unavailable` placeholder naming
your plugin, a disabled plugin's route paints the `disabled` one, and an unclaimed prefix paints
`unknown` — three named answers instead of a 404 that reads like the workspace forgot the link.
`core.uri` is the worked example: it claims `uri`, contributes nothing else, and exists as a
plugin precisely so the deep-link path can be turned off, named and refused like anything else.

**bindings** — the keys your plugin answers to:

```ts
// src/web.ts
import type { WebBinding } from "@manifold/plugin";

export const MY_BINDINGS: readonly WebBinding[] = [
  {
    id: "example.notes.focus", // namespaced by YOUR plugin id, or composition refuses the row
    key: "F6", // a KEYSTROKE: `KeyboardEvent.key` verbatim, optionally prefixed `Mod+`
    label: "Focus notes", // how the sidebar's key table reads it
    when: "always", // or "canvas" / "composition"; defaults to "always"
    run: (host) => {
      /* your handler */
    },
  },
];
```

A binding is a DECLARATION, and a key is claimed globally: two plugins that want `F6` fail
composition naming both, exactly as two plugins claiming one tool id do. It carries no authority
— dispatch calls your `run`, and anything that MUTATES fires a registered action from there, at
the gesture's commit point.

**The key is a KEYSTROKE, and its grammar has exactly one modifier.** `F6`, `?` and `ArrowUp`
are keys; `Mod+k` is a key too, and `Mod` is the platform's primary modifier — Command on Apple
hardware, Control everywhere else. One token rather than two rows, because a table that spelled
both would let you claim a chord on one platform and leave it free on the other, which is a
collision composition could not see. There is no `Alt`: it changes the character the layout
produces, so `event.key` under it differs per keyboard. There is no `Shift` either — it is
already inside `KeyboardEvent.key`, so name `?` and be done. The grammar is
`parseKeystroke`/`keystrokeMatches` in `@manifold/plugin`, and the same functions decide what
fires, what the key table prints and what the editor captures.

**A chord is a real claim on the browser's key.** `Mod+K` is "focus the address bar" in Chrome,
Edge and Firefox — a preventable default, unlike `Mod+T` or `Mod+W`, which is why command
surfaces on the web live there. Claiming one means the dispatcher calls `preventDefault()` on
it, so claim deliberately, and know a reader can rebind your row.

The host owns the listener, so keystrokes going into a text field are refused for every BARE
row at once — a printable key belongs to the field it is typed into. A chord is exempt, because
it is not a character any field is trying to receive. The composed table is published on the
browser assembly and printed by the sidebar's key table, so a reader learns your key without
reading your code — and a disabled plugin's rows drop out of both, because a key that still
answered would be running a disabled plugin. `when` is declared for readers rather than
enforced by the engine: your handler is the only thing that knows your surface.

**Printing a key is not owning one.** Anything may print a row off `host.assembly.bindings`; if
you do, draw it with `KeyCap` from `@manifold/plugin/ui` (the one keycap, and the one place
`Mod` becomes ⌘ or Ctrl) and send a reader who wants to change it through `requestRebind(id)`,
which the workspace's binding editor answers. Neither side names the other.

---

## 7b. Layout primitives

`@manifold/plugin/ui` ships a small layout algebra; compose your section and renderer
bodies with it instead of writing bespoke flex/overflow CSS. Six intrinsic boxes:

- **`Stack`** — vertical rhythm (`gap`, optional `align`). The default for any section body.
- **`Cluster`** — a row that WRAPS instead of overflowing: toolbars, label-beside-count.
- **`Sidebar`** — the two-column content+aside pattern; self-stacks when the content pane
  would drop under its declared minimum share.
- **`Switcher`** — row → column past a container-width threshold, all-or-nothing.
- **`Cover`** — full-height box with a vertically centered principal: empties, placeholders.
- **`Frame`** — an aspect-boxed window for media; clipping is its declared contract.

Each is a thin `<div>` + one CSS family; knobs travel as CSS custom properties
(`gap="0.4rem"`), and every primitive merges `className`/`style` and forwards div
attributes, so you can tighten or entirely out-style one — a baseline, never a prison.
The discipline they enforce for you: `min-width: 0` on every child, gap-based spacing
(never margins between siblings), `clamp()`ed adaptive defaults. Two obligations remain
yours:

1. **Every text node declares an overflow contract** — ellipsis
   (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`) for labels, or wrap
   (`overflow-wrap: anywhere`) for prose. R9 sweeps adversarial names through the sidebar
   and fails undeclared overflow, undeclared clipping, child-escapes and sibling overlaps.
2. **Constraints, not fixed widths** — `max-width: min(10rem, 100%)`, never a bare pixel
   width that a narrow pane cannot honor.

Behavior chrome lives beside the algebra: `Disclosure` (a header that folds the body
under it; body stays mounted while closed) and `ScrollRegion` (vertical-only scrolling
with the product's overlay thumb; horizontal overflow is refused by contract — a child
that cannot shrink must declare ellipsis or wrap). Their engines are internals
(`docs/decisions/2026-08-31-radix-behavior-primitives.md`); never import `@radix-ui/*`
directly — S2 fails the gate.

The sidebar element is a size container (`container: sidebar / inline-size`), so your
section CSS may density-query it: `@container sidebar (max-width: 236px) { … }`.

## 8. What the gate checks

`bun run verify:axioms` runs in `bun run gate`. It has a static half and a browser half; these
are the checks that will fail _your_ plugin:

- Both `assembly.ts` files assemble without an `AssemblyError`, and every panel id referenced by
  the default workspace layout exists.
- **Import boundary** (walked with the TypeScript parser, not regex): floor files must not
  import `@manifold-plugin/*` — the two `assembly.ts` files are the only exceptions — and
  plugin packages may import only `@manifold/{protocol,scene,sdk,plugin}`.
- **Import direction follows the plugin tree** (S18, ratified 2026-09-05 and not yet enforced —
  it lands with [#261](https://github.com/atyrode/manifold/issues/261)): a parent never imports a
  part, a part imports only its parent's `contract` subpath, and the `contract` module imports only
  the four floor packages (§1, "A part lives inside its parent's package"). Until then S2 above is
  the check that runs, and it cannot see a part's files.
- **Every `data-action` literal names an assembled action.**
- **Every `localStorage` key in `packages/{web,plugins}` is listed in the `REGISTRY.md`
  device-local register.**
- **Every word you name things with is in the `REGISTRY.md` §Lexicon registry** (S11): a retired
  synonym in an identifier, a wire literal, a CSS selector, a file name or a doc heading fails
  the gate, and so does an `allow` exemption that no longer suppresses anything. This is the check
  most likely to fail a NEW plugin, because a new plugin brings new words: if your feature needs a
  term the registry does not have, add the row in the same commit — that direction is cheap by
  design.
- **Exactly one table translates an item kind into a display noun** (S12): `ITEM_NOUNS` in
  `packages/plugin/src/item-noun.ts`, whose keys are the floor kinds and whose answer for a
  CONTRIBUTED kind is your manifest's element `title`. Never ship a second lookup — declare the
  title and let the floor read it.
- Every `packages/plugins/*` directory is registered per the halves it exports, and every
  assembled definition maps back to a package.
- Every floor glob in the registry matches at least one file (the registry cannot rot silently).
- The `/api/…` route literals in the server equal the documented allowlist — a bespoke feature
  route added outside the action door fails the gate by construction.
- Every `SceneElementSchema` member type is either an engine floor kind or an assembled element
  type.
- **Your stylesheet paints only families you own** (S13): every selector family in every `.css`
  file under `packages/` resolves to a `REGISTRY.md` §Lexicon `cssFamilies` row, and every rule
  is defined by the owner of the leftmost family it scopes into. A family painted from another
  package's sheet, a family with no row, a row whose stylesheet defines nothing, or a classless
  rule outside the floor sheet — each is RED, named by file and selector.
- In the browser: `/api/protocol` and `/api/plugins` agree with the assembly; hot
  enable/disable takes effect without a reload; an action invoked over the SDK is observed in
  the DOM and vice versa; the denial ladder returns the documented rules.
- Every floor file falls inside exactly one pillar of the `REGISTRY.md` pillar inventory — an unowned
  file above the plugin boundary is RED.
- The list of every `cleanup: true` action in the assembly is published, so the one carve-out
  from the disable rule cannot grow unnoticed.
- **The event plane is exercised end to end** (R10): a browser subscribed to a collection, an SDK
  peer subscribed to the same node, and a third principal mutating through the action door. The
  frame's topic, kind and actor must be right, the browser's UI must reflect the change inside one
  second with no timer tick behind it, and a container-scoped token asking for a foreign
  collection must be refused in silence. `REGISTRY.md` §Budgets is the standing half of the same
  claim: every network row is ZERO at idle, so a plugin that opens a timer onto a door shows up as
  a rate with its own name on it.

## 9. Writing a hardened (out-of-tree) plugin

Everything above describes the IN-REALM target: a plugin handed the engine's real objects —
React, `@manifold/plugin`, `HostServices`, the full `ActionCtx`. That is the ratified default for
EVERY row, installed ones included (ADR 0025, operator-ratified 2026-09-05); the loader that runs
an installed bundle in-realm is owed (#256), and until it lands every installed row runs the way
this section describes. This section is the HARDENED target (ADR 0016, stage 1+2): a row its
installer chose to isolate — `install.hardened: true` once #256 lands, every installed row
today — authored anywhere, packed into one artifact, installed at a door, and run as a stranger's
code: its server half in its own Bun process, its web half in its own dedicated `Worker`, against
the narrower interface below. The manifest decides which target you are writing for: an in-tree
manifest has no `entry`; an installed one must, and `entry` names the halves the bundle runs
(`{ "server": true, "web": "web.js" }`). Nothing else about the manifest changes — same id
grammar, same capability ceiling, same `contributes`, same assembly refusals, same denial ladder
at the door. Authoring an in-realm plugin on a running instance is §10, owed with the loader (#260).

The kit is `@manifold/plugin-kit` (`packages/plugin-kit`; the reference plugin it ships is
`packages/plugin-kit/test/fixtures/sample/`, quoted below). It depends on `@manifold/protocol` and
zod and on nothing else, which is exactly what your plugin may depend on: an isolated plugin never
imports `@manifold/plugin`, `@manifold/sdk` or `@manifold/scene`.

### The server half: `server.ts`

```ts
import { defineServerAction, defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "./manifest.json";

const bump = defineServerAction({
  name: "bump",
  title: "Bump the counter",
  caps: ["containers:read"],
  input: z.strictObject({ by: z.number().int().min(1).max(100).default(1) }),
  result: z.strictObject({ count: z.number().int() }),
});

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [bump],
  handlers: {
    async bump(ctx: GuestCtx, args: { by: number }) {
      const count = Number((await ctx.storage.get("count")) ?? "0") + args.by;
      if (count > 1_000) return { refused: "the counter stops at one thousand" };
      await ctx.storage.set("count", String(count));
      ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, "counter_bumped", { count });
      return { count };
    },
  },
  lifecycle: {
    async onEnable(ctx) {
      if ((await ctx.storage.get("count")) === null) await ctx.storage.set("count", "0");
    },
  },
});
```

`defineServerPlugin` is inert when the module is merely imported and wires the ipc channel when
the module is the entry of a spawned isolate, so the same file is the plugin AND its own test
subject. A handler is written against `GuestCtx`, which is the engine's `ActionCtx` as it can be
served across a process boundary (`docs/CONTRACTS.md` §Hardened plugins, `ISOLATE_CTX_METHODS`):

- **Data the dispatch carries** — `ctx.principal`, `ctx.auth.{caps, isRoot, containerScope}`,
  `ctx.traceId`, `ctx.containerScope`, `ctx.now()`, `ctx.pluginId`.
- **Questions the host answers, as promises** — `ctx.auth.allows(cap, containerId?)`,
  `ctx.outsideScope(containerId)`, `ctx.newId()`, `ctx.storage.{get, set, delete, keys}`,
  `ctx.machines.isOnline(id)`, `ctx.placement.place(request)`, `ctx.host.{roster, enabled}`.
  Every one is a `call` frame correlated to the dispatch it belongs to, graded as that dispatch's
  caller; a call the host refuses rejects with `HostCallError` carrying the host's own sentence.
- **`ctx.emit`** stages exactly as in-realm: the emissions ride back with the outcome and the host
  flushes them only when the dispatch is `ok`.

Two rungs of the ladder are graded IN YOUR PROCESS (`ISOLATE_GUEST_DENIAL_RULES`): the runtime
parses arguments against your action's own zod `input` (`invalid_args`, the engine's wording) and
your handler's `{ refused }` is `refused`. Every other rung — unknown action, disabled plugin,
scope, capabilities including the installer's grant — is the host's, and a dispatch never reaches
you until it has passed them. Your `result` schema is enforced on the way out too, and the roster
publishes both as JSON Schema from the `loaded` frame, generated from the zod you wrote.

A hook (`onEnable`, `onDisable`, `onAssemblyChanged`) gets storage and the clock. It does NOT get
`emit`: the `hooked` frame has no carrier for emissions, so a hook that emits fails by name instead
of publishing into the void.

### The web half: `web.ts`

```ts
import { ui } from "@manifold/plugin-kit";
import { definePanel, defineWebPlugin } from "@manifold/plugin-kit/web";
import { z } from "zod";

const BumpResult = z.object({ count: z.number().int() });

const counter = definePanel<{ count: number | null; denial: string | null }>({
  init: () => ({ count: null, denial: null }),
  view: (state) =>
    ui.box({ direction: "column", gap: 2 }, [
      ui.heading("Counter", 2),
      state.count === null ? ui.spinner("Waiting") : ui.badge(`count ${String(state.count)}`),
      ui.button("Bump", "bump", { tone: "accent", action: "example.counter.bump" }),
      state.denial === null
        ? ui.empty("No refusal yet.")
        : ui.text(state.denial, { tone: "danger" }),
    ]),
  update: async (state, event, host) => {
    if (event.event !== "bump") return state;
    const outcome = await host.action("example.counter.bump", { by: 1 });
    if (!outcome.ok) return { ...state, denial: outcome.denial.message };
    return { ...state, count: BumpResult.parse(outcome.result).count, denial: null };
  },
  subscribe: (_host, emit) => {
    const timer = setInterval(() => emit({ event: "tick" }), 60_000);
    return () => clearInterval(timer);
  },
});

defineWebPlugin({ id: "example.counter", panels: { counter } });
```

A panel is a PROGRAM over its own state, not a component: `init` makes the state, `view` projects
it into a tree of the closed vocabulary, `update` folds a named callback (`{ event, payload }`)
into the next state, and `subscribe` is the only place a timer or a poll lives — its return value
stops it at unmount. Events fold in order, one at a time, even while an `update` is still
awaiting the host. The runtime re-renders after every `init` and `update`; there is no manual
re-render and no partial one — the whole tree is posted and the engine diffs it.

`GuestHost` is the viewer's identity as data (`principal`, `caps`, `containerId`) plus the nine
`WEB_HOST_METHODS` as promises — `action`, `place`, `selfCaps`, `machines`, `resolve`, `navigate`,
`openTerminal`, `sendTerminalInput`, `terminalsByContainer` — each with the semantics of the
`SessionHandle` method of the same name (§Host services). They are served by the page from the
panel's REAL host services, which is how a worker acts with the viewer's authority without ever
holding the viewer's token.

### The vocabulary

Thirteen kinds, five tones, no escape hatch (`UiNodeSchema`; `GET /api/protocol` publishes it
under `isolateContract`). `ui` has one builder per kind, typed against the protocol's union:

| Builder                                                           | Renders as                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ui.box({ direction, gap, grow, wrap }, children)`                | a flex box; `direction` defaults to `column`, `gap` (0–3) to 1                                                    |
| `ui.heading(text, level?)`                                        | a heading; `level` defaults to 2                                                                                  |
| `ui.text(text, { tone, mono, wrap }?)`                            | prose; ONE line truncated with an ellipsis unless `wrap: true`; `mono` is the shell's monospace family            |
| `ui.code(text)`                                                   | a preformatted block (up to 64 KiB)                                                                               |
| `ui.badge(text, tone?)`                                           | a small status chip                                                                                               |
| `ui.divider()`                                                    | a rule                                                                                                            |
| `ui.spinner(label?)`                                              | an in-progress marker                                                                                             |
| `ui.button(label, event, { payload, tone, disabled, action }?)`   | a button posting `event` with `payload`; `action` is painted as `data-action` (set it, §Marking your affordances) |
| `ui.select(event, value, options, { label, disabled }?)`          | a select posting `event` with the chosen value; `value: null` shows an empty placeholder option                   |
| `ui.input(event, value, { label, placeholder, mono, disabled }?)` | a text field posting `event` with the string on every change                                                      |
| `ui.toggle(event, value, label, { disabled }?)`                   | a switch posting `event` with the new boolean                                                                     |
| `ui.list(items)`                                                  | rows of `{ key, primary, secondary?, tone?, event?, payload? }`; a row with `event` is a button                   |
| `ui.empty(text)`                                                  | the engine's own empty-state row                                                                                  |

Tones are meanings — `neutral`, `accent`, `muted`, `danger`, `success` — never colours. A tree is
refused past 32 levels or 2000 nodes, and a node with a key the kind does not have (`style`,
`className`, `onClick`) is refused rather than ignored; the runtime parses every tree before it
posts one, so a bad tree becomes a `fault` naming the panel and the engine paints the panel as
`empty` with tone `danger`. There is no plugin CSS. Ink has one owner (S13).

### Packing

```sh
bun run --cwd packages/plugin-kit pack <plugin-dir> --out example.counter.manifold-plugin.json
# {"file":"example.counter.manifold-plugin.json","sha256":"e984…","bytes":1586951}
```

`pack` reads `<plugin-dir>/manifest.json`, bundles `server.ts` (target `bun`) and `web.ts`
(target `browser`) with the kit, the protocol and zod INLINED — the artifact is self-contained and
the engine's loader never resolves a package — and writes one JSON document (`PluginBundleSchema`:
`format: 1`, the manifest with its `entry`, the members as base64). The printed `sha256` is over
the file's exact bytes and is the pin `engine.plugins.install` demands; the door itself — where a
source may come from, the default grant, the refusal classes, where the bundle lives afterwards —
is §7 Installing a plugin, and the artifact's shape is `docs/CONTRACTS.md` §Hardened plugins.

### Developing against a hub

Packing is the artifact; the loop is `dev` (issue #319), and it exists because the only way to see
an isolated plugin change is on a running hub — the isolate respawned, the web half re-served
`no-store`, a browser reload. `dev` walks a directory for every `manifest.json` (a part inside its
parent's directory, ADR 0023; `node_modules` and `dist` are never entered), packs each into a
temporary directory, installs parents before parts, then watches the directory and repeats on
change, debounced, installing only the bundles whose sha moved. One JSON line per cycle.

```sh
# from a manifold checkout, pointing at your plugins directory
bun run --cwd packages/plugin-kit dev <plugins-root> --hub http://127.0.0.1:7777 --owner-key-file <data>/owner.key
# from an author repository with manifold checked out beside it (the pack.sh layout)
bun run dev -- --hub http://127.0.0.1:7912 --deliver docker:manifold-dev-manifold-1
```

Every cycle is `install`, the one-shot command underneath, and `install` is idempotent over the
hub's roster: it reads `GET /api/plugins` first, and the same id at the same sha is `unchanged`
(nothing asked of the hub); another sha is `replaced` — `engine.plugins.setEnabled false`,
`engine.plugins.install { replace: true }`, `setEnabled true`, the three steps §7 demands; an
absent id is `installed`. A replace is FAMILY-aware: the engine refuses to switch off a row an
enabled row declares `required` (`missing_dependency`), so replacing `atyrode.code` while
`atyrode.code.generator` is on switches the dependents off first, deepest first (transitively,
read from the roster's manifests), then the target, and after the install switches the target
and then the dependents back on in reverse. If the replace is refused, the old bundle stays and
everything goes back on in that same order. It answers one line, `{ id, sha256, hub, outcome }`,
and a refusal exits non-zero with the class and detail (`hash_mismatch: …`) on stderr.

```sh
bun run --cwd packages/plugin-kit install:bundle <bundle | https://…> --hub <url> \
  [--sha256 <hex>] [--deliver path | docker:<container>] [--owner-key-file <path>]
```

**Two delivery strategies**, because the door reads a path or an https URL and nothing else
(§7): `--deliver path` (the default for a file) hands the hub the bundle's absolute path, which a
hub on the same machine accepts under `MANIFOLD_PLUGIN_DEV_PATHS=1` or from its drop box;
`--deliver docker:<container>` copies the bundle into `<container>:/data/plugin-uploads/` — the
drop box every hub accepts — and installs from there, which is how a hub in a container on the
box you are sitting at is reached. An `https://` source is handed through untouched. **The owner
key** comes from `--owner-key-file`, else `MANIFOLD_OWNER_KEY_FILE`, else — with docker delivery —
the container's own `/data/owner.key` over `docker exec`. It is never an argument and never
printed.

The hub an author sees a change on is the **integrated preview**, `https://preview.<domain>`
(`infra/previews/README.md`): it follows every green `main` and runs on the preview host as compose
project `manifold-dev`, container `manifold-dev-manifold-1`, port `127.0.0.1:7912`. From that
host, the second command above installs your working tree on it as you save. Production is not a
development target (§Delivering).

### Verifying

An author repository's own tests drive a fake host. `verify` is the command that proves the
artifact composes with a REAL engine, and it is `packages/testkit/e2e/isolated-plugin.test.ts`
made public, because `@manifold/testkit` is private and an author repository cannot import it:

```sh
bun run --cwd packages/plugin-kit verify <bundle>...
# {"bundle":"dist/example.counter.manifold-plugin.json","id":"example.counter","sha256":"8b8a…","doors":{"example.counter.bump":"ok"}}
```

It spawns this checkout's server (a temporary data dir, a fixed throwaway owner key, a free port,
`MANIFOLD_PLUGIN_DEV_PATHS=1`), installs the bundles parents first whatever order the shell glob
handed them, and for each asserts that its roster row is enabled and its `lifecycle` is neither
`enable_failed` nor `isolate_crashed`, then dispatches every door the row publishes with `{}` as
the owner and requires any answer but `unavailable` — `invalid_args` and `refused` come from your
code in your process, which is the fact being checked; `unavailable` is the runner saying that
process is gone or mute. Then it uninstalls with `purge` in reverse. The first failure exits
non-zero naming the bundle, the row or the door.

In CI, the reusable workflow `.github/workflows/plugins.yml` (`workflow_call`, input
`plugins-dir`, default `plugins`) does the whole sequence: it checks the caller out at `caller/`,
reads `caller/<plugins-dir>/MANIFOLD_REV`, checks this repository out at that rev at `manifold/`
beside it (the sibling layout an author repository's `pack.sh` resolves), installs both, then in
`caller/<plugins-dir>` runs `bun run check`, `bun test`, `bun run pack`, `bun run verify` and
uploads `dist/` as the `manifold-plugins` artifact. An author repository's CI is one job:

```yaml
jobs:
  plugins:
    uses: atyrode/manifold/.github/workflows/plugins.yml@<MANIFOLD_REV>
    with:
      plugins-dir: plugins
```

`plugins/MANIFOLD_REV` and that `@<rev>` are bumped together, so the workflow and the kit it runs
are one commit of this repository. The author repository's `plugins/package.json` wraps the kit:
`verify` is `bun ../../manifold/packages/plugin-kit/src/verify.ts dist/*.manifold-plugin.json`
(the shell expands the glob) and `dev` is `bun ../../manifold/packages/plugin-kit/src/dev.ts .`,
flags passed through after `--`.

### Delivering

A release of an author repository (`release.yml` on `v*`) packs, attaches `dist/*.manifold-plugin.json`
and `SHA256SUMS` to the GitHub Release, and then — for each bundle, parents first — asks the
preview host's receiver to install it on the integrated preview:
`ssh <user>@<host> "plugin https://github.com/<owner>/<repo>/releases/download/<tag>/<id>.manifold-plugin.json <sha256>"`
over the same forced-command deploy key manifold's own `deploy-dev.yml` uses (`secrets.DEV_DEPLOY_SSH_KEY`,
`vars.DEV_DEPLOY_HOST`; the step is skipped when the variable is unset). The receiver's `plugin`
verb runs `install` from the host's stable tooling checkout against the dev stack with
`--deliver docker:<container>`, reading the owner key out of the container — no secret leaves the
host, and nothing but an https URL and a hash crosses the socket (`infra/previews/README.md`).

Production (`https://manifold.tyrode.dev`) is the one hub nothing automates: the operator installs
a release there from its asset URL in the plugin manager, root only, by hand (ADR 0022). A change
is "delivered" when its release is installed on the integrated preview; whether it reaches
production is the operator's decision, not a workflow's.

**What an author repository's `AGENTS.md` must tell its agents**, because an agent there never
reads this file first: the four commands in `plugins/` (`bun run check`, `bun test`, `bun run pack`,
`bun run verify`) and that `verify` is the gate that spawns a real engine; that the inner loop is
`bun run dev -- --hub <url> --deliver docker:<container>` against the integrated preview from the
preview host, and its URL; that `plugins/MANIFOLD_REV` and the `uses:` ref move together; that a
release installs itself on the preview and never on production; and what to tell the operator to
look at — the preview's plugin manager row for the id, and the panel or door the change touched.

### What an isolated plugin does NOT get (ADR 0016 §3)

Say it out loud rather than discover it:

- **No React, and no `@manifold/plugin`.** No `usePolledResource`, no `@manifold/plugin/ui`
  primitives, no tile geometry, no projection registry, no `HostServices` object. The web half
  is a program over the vocabulary, full stop.
- **No token.** `HostServices.token` is a real bearer handed to trusted in-realm code; a worker
  never holds it. It calls the door through the host, which attaches the viewer's authority.
- **No Yjs.** `ElementTx.text()` hands back a live `Y.Text`, which cannot cross a boundary, so
  **an isolated plugin cannot contribute a collaborative-text element renderer** — nor any element
  renderer, section, tool, route or overlay in stage 1: `panels` are the one web contribution kind
  a worker serves. This is ADR 0016's T3 stated plainly: element renderers are a two-class
  contribution, and after this wave WHICH interfaces a stranger's agent can author against depends
  on how the plugin is distributed. `core.notes` is the worked example of what stays first-party.
- **No engine object.** `ctx.store`, `ctx.rooms`, `ctx.broker`, `ctx.identity`, `ctx.dials` and
  the storage ledger verbs (`dataVersion`, `appliedMigrations`) are not served in stage 1. They are
  absent from `GuestCtx`'s type, and reaching one at runtime anyway raises
  `IsolateSliceUnavailable` — which the runtime answers as `refused`, a named rung at the door.
- **No other plugin's anything.** Storage, event kinds, roster rows: unreachable by construction
  rather than by contract.

What you DO get is the same door: an installed plugin's actions sit on the roster beside
first-party ones, are traced at every dispatch, and answer the same ladder — plus the runner's own
states, which are roster data (`lifecycle: "isolate_starting" | "isolate_crashed"`) and a named
refusal (`unavailable`) when the isolate is gone or did not answer in `ISOLATE_DISPATCH_DEADLINE_MS`.

## Further reading

- `AXIOMS.md` — the axioms, the plane rule, the foundation law, the lexicon law and the roadmap.
- `REGISTRY.md` — the enforcement data those laws index: the pillar inventory, the floor
  registry, the lexicon and `cssFamilies` rows, the device-local register, the gate contracts,
  the per-kind disable table and the check inventory.
- `docs/decisions/0013-plugin-behavioral-contract.md` — the behavioral contract: lifecycle,
  dormancy, retain-only disable and purge, dependencies, data versions, ownership reservation, the
  engine-owned enablement door, and the foundation litmus test.
- `docs/CONTRACTS.md` — the wire: routes, frames, capabilities, presence payloads.
- `docs/decisions/0010-plugin-engine-and-action-plane.md` — the trust model and why the action
  envelope looks like this.
- `docs/decisions/0011-permission-waterfall.md` — per-node authority: the grant row, the
  precedence order, and the "Landed" section recording the shapes that shipped.
- `docs/decisions/0012-event-plane.md` — the event plane: why `contributes.events` looks like
  this, and the "Landed" section recording the shapes that shipped.
