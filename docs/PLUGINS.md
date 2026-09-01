# Writing a manifold plugin

**Read this if you are an agent.** This file plus two live endpoints are the complete
onboarding surface; you should not need to read manifold's source to author a plugin.

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
      type: "required",
      reason: "strokes are canvas elements; without the canvas renderer the tool has no surface",
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
    elements: [
      {
        type: "draw",
        title: "Drawing",
        placement: { groups: ["canvas_item"], guards: [], homed: "inline" },
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
  distribution registered it). Pick your own leading segment (`acme.notes`); it needs no
  registration anywhere and buys you exactly what `core.` buys manifold, which is nothing but a
  name (§7, "Three orthogonal facts about a plugin").
- **Contribution ids are local names** (`^[a-z][a-zA-Z0-9-]*$` — interior capitals are allowed
  where the name is a verb phrase, as in `setEnabled`), with two exceptions that are WIRE kinds
  and therefore globally unique on their own: element `type`, and event `id`, which is
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
  sides. There is **no enable cascade**: enabling you never silently enables anything else, and
  disabling a plugin that others require is refused, naming them.
- **`after` is ordering, not requirement.** It contributes to the deterministic order the engine
  composes and fires lifecycle hooks in (topological over `dependencies` ∪ `after`, ties broken by
  lexicographic id). A cycle is an `AssemblyError`.
- **`dataVersion` governs your stored rows** (§4). Bump `minor` freely; bumping `major` without a
  migration refuses to assemble your plugin, and data written by a newer `major` than your code
  refuses too — the engine never guesses at your schema.
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
  `draw` row verbatim). When you DO declare it, all three fields are required: `homed: null` is how
  you say "no home", not omission. There is no canvas-operation key — the op is derived by the
  algebra, which is the half that stays engine (ADR 0013 §12). The container-site-only guard
  `discipline_match` is refused on an element. Every closed wire literal is `snake_case`.

- **`purges` is a declaration for audit, never a trigger.** It says which of the closed purge
  targets (`storage`, `elements`, `ownership`) you hold, so a human can see what
  `engine.plugins.purge` would cost before pressing it. Nothing about disable reads it.
- **`events` declares the event kinds you originate** (§6b). The id is `snake_case` and globally
  unique: a kind belongs to one plugin, and the engine refuses an emission of a kind another
  manifest declared. `entry` is still reserved — write it if you like; nothing reads it this wave.

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

| #   | Rule              | Fires when                                                                                                                                                                                                                                              |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `unknown_action`  | No assembled action by that full name.                                                                                                                                                                                                                  |
| 2   | `plugin_disabled` | The owning plugin is disabled in this workspace. Skipped for actions declared `cleanup: true` (D12).                                                                                                                                                    |
| 3   | `forbidden`       | The caller's token is **container-scoped** and your action's `scope` is `"workspace"` (the default). Message: `scoped tokens cannot invoke workspace actions`. Declare `scope: "container"` when the door you replaced was reachable by a scoped token. |
| 4   | `forbidden`       | The caller lacks one of the action's declared caps **at the node it is asking about** — its own container for a scoped token, the workspace root for an unscoped one (ADR 0011).                                                                        |
| 5   | `invalid_args`    | The payload fails the action's `input` schema.                                                                                                                                                                                                          |
| 6   | `refused`         | The handler returned `{ refused }`, or the engine refused by class — e.g. `essential`, `builtin`, `still_enabled`.                                                                                                                                      |

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
    onEnable: (ctx) => {
      ctx.storage.set("lastEnabledAt", String(ctx.now()));
    },
    // You are being turned OFF. Flush and park — never delete user data here.
    onDisable: (ctx) => {
      ctx.storage.set("parked", "1");
    },
    // SOMEONE ELSE changed. Repair your own references to what left or arrived.
    onAssemblyChanged: (ctx, delta) => {
      if (delta.disabled.includes("core.canvas")) ctx.storage.set("parked", "1");
    },
    // You are being destroyed. The engine clears your namespace and releases your element
    // types either way; this hook is for anything only YOU know about.
    onPurge: (ctx) => {
      ctx.storage.delete("parked");
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
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(prefix?: string): readonly string[]; // sorted; the engine's own `$` rows are never listed
  dataVersion(): PluginDataVersion | null; // null until something has been stamped
  appliedMigrations(): readonly string[]; // bare names, in application order
}
```

It is **synchronous** (the substrate is Bun's SQLite — an async facade would buy a promise per read
and no concurrency) and **string-valued**: serialize your own structures. Keys match
`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$` and values are ≤64 KiB; a `$` prefix is engine-reserved and
`set`/`delete` throw on it, which is what makes the version stamp and the migration ledger something
you can read but not forge. If you have more than 64 KiB of a thing, it is a document, and documents
have a plane (§5).

When your stored shape changes incompatibly, bump `dataVersion.major` and ship a **named**
migration:

```ts
export const serverDef = {
  manifest, // dataVersion: { major: 2, minor: 0 }
  migrations: [
    {
      name: "2026-09-01-split-stroke-points", // the ledger records NAMES, stable under rebase
      to: { major: 2, minor: 0 }, // the version this migration produces
      migrate: (storage) => {
        for (const key of storage.keys("stroke:")) {
          const raw = storage.get(key);
          if (raw !== null) storage.set(key, rewrite(raw));
        }
      },
    },
  ],
  // …
};
```

Migrations are **synchronous** for the same reason a migration must be all-or-nothing: no `await` in
the middle of a rewrite, no dispatch interleaving with half a conversion. They run at boot for
enabled plugins and at the enablement door for a plugin being switched on — never for a disabled
one, whose data is retained untouched and re-judged when someone turns it back on. Applied names are
recorded in the ledger, so none ever runs twice. The rules the engine applies, adopted from Home
Assistant's asymmetry:

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
type you have not read:

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
  readonly principal: Principal; // who this device is — paint in this principal's colour
  readonly token: string; // this device's bearer: the grant a renderer opens its own pipe with
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
  subject is being created or destroyed, or has no `manifold://` form at all (a machine, a
  folder), that node is your COLLECTION: `manifold://plugin/<your id>`, built from your own
  manifest id so the address and the declaration cannot drift. The engine refuses an emission on
  another plugin's node. A collection topic is also what makes a client's whole feed one
  subscription instead of one per row.
- **Emission is STAGED.** `ctx.emit` buffers; the buffer flushes only after your handler returned
  successfully and its declared result schema parsed. A handler that mutates and then refuses,
  throws, or fails its own schema publishes nothing — refusals are not events, and you do not
  have to remember that.
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
- **Your own namespace is yours.** `acme.notes` needs no registration anywhere, collides with
  nobody, and gets exactly the same dispatch, authority, disable, dormancy and purge treatment
  `core.notes` gets. If you find a rule that treats a `core.` row better, that is a bug worth an
  issue: it is the claim this table exists to keep checkable.

`GET /api/protocol` publishes both prefixes (`engineNamespace`, `coreNamespace`), so an author
choosing an id learns which two are taken without reading this file.

### The web registration channels

A plugin's web half registers through six channels, and every one of them refuses a duplicate
by name. Two get their own subsection below — **bindings** and **workspace overlays**; here is
what all six are keyed by, and which of them the manifest declares:

| Channel               | Keyed by                                                                  | Manifest row                         |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| **renderers**         | a container DISCIPLINE (`canvas`, `composition`)                          | no                                   |
| **overlays**          | a container overlay SLOT (`container-roster`, `container-spotlight`)      | no                                   |
| **workspaceOverlays** | a workspace overlay SLOT (`inspector`, `toolbar`)                         | no                                   |
| **terminal facet**    | nothing: one viewer per workspace, published for other renderers to mount | no                                   |
| **bindings**          | a KEY (`F6`), claimed globally                                            | no — declaration IS the registration |
| **routes**            | a path SEGMENT you invent (`uri` serves `/uri/<rest>`)                    | **`contributes.routes`**             |

**Only `routes` has a manifest counterpart, and the key column says why.** The first four are
keyed by CLOSED vocabularies the engine owns, so there is nothing for a manifest to publish
that `GET /api/protocol` does not already publish — and none of them is a ref the WORKSPACE
composes, so no layout and no sidebar order can name one. A path segment is the opposite: a
name its author invents in a space every plugin shares, which is why it is `contributes.routes`
(§6) and why the browser's route table is keyed off the CLAIM rather than off whatever a web
half exported. Declaring it is what lets the roster publish the paths a build answers on, and
what makes a registration for an undeclared segment contribute nothing.

**A duplicate on any of the six is a refusal naming both offenders** — the four projection
channels and routes in `buildBrowserAssembly` (`packages/web/src/plugin-host.tsx`), bindings in
`composeBindings` — in the same sentence assembly uses for a duplicate section or element type:
`duplicate overlay "container-roster" claimed by: core.presence, acme.presence`.
Claims are collected over the whole roster, disabled plugins included, so turning a plugin off
can never mask a collision that turning it back on would resurrect. Until wave F the second
registrant silently won by roster order, which made the owner of a discipline, a slot, a path or
the terminal viewer a function of composition order (issue #112).

Read `packages/web/src/assembly.ts` and `packages/plugin/src/projection.ts` for the shapes.

**workspace overlays** — chrome with no container to hang on:

```ts
// src/web.tsx
export const acmeWebPlugin = {
  id: "acme.notes",
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
and the workspace frame alike, and `core.arrange`'s toolbar is about the arrangement of the
workspace rather than about anything inside a room. Everything else belongs in a container's
slot, a panel or a section.

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
  id: "acme.notes",
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
    id: "acme.notes.focus", // namespaced by YOUR plugin id, or composition refuses the row
    key: "F6", // a KeyboardEvent.key value, verbatim
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
the gesture's commit point. The host owns the listener, so it refuses chords (`Ctrl+F6` is a
different key) and keystrokes going into a text field for every row at once. The composed table
is published on the browser assembly and printed by the sidebar's key table, so a reader learns
your key without reading your code — and a disabled plugin's rows drop out of both, because a
key that still answered would be running a disabled plugin. `when` is declared for readers
rather than enforced by the engine: your handler is the only thing that knows your surface.

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
