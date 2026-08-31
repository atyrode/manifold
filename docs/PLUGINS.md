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
whole icon set stays a change to one file and no call site. What is CLOSED there is the engine's
own verbs — `ControlKind` is a fixed list because a control is one of manifold's own actions —
while a vocabulary the ASSEMBLY owns stays open: `ItemIcon` takes any item kind, your contributed
element types included, and draws a neutral element mark for a kind it holds no drawing for
(#69 wave F). `@manifold-plugin/terminals/web` is the worked example: its terminal viewer owns no
drawing and no notice mechanism of its own.

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
  // essential: true,              // optional; only core.shell claims it
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
    panels: [], // { id, title }        — a workspace tile leaf
    sections: [], // { id, title, order } — a sidebar section
    elements: [
      {
        type: "draw",
        title: "Drawing",
        placement: { groups: ["canvas_item"], guards: [], homed: "inline" },
      },
    ],
    tools: [{ id: "draw", title: "Draw" }], // a toolbar tool
    events: [], // reserved: the wave-2 event plane (ADR 0012). No consumer yet.
  },
  // entry: { web: "...", server: true }, // reserved: dynamic distribution, a later wave
};
```

Rules worth knowing before you write one:

- **The id must be dotted** — at least one `.` — and it namespaces everything you contribute.
  A panel `sidebar` contributed by `core.shell` is globally `core.shell.sidebar`. The prefix
  `engine.` is **reserved**: it belongs to the engine's own builtin doors, and assembly refuses
  any plugin that claims it.
- **Contribution ids are local names** (`^[a-z][a-zA-Z0-9-]*$` — interior capitals are allowed
  where the name is a verb phrase, as in `setEnabled`), except element `type`, which is a wire kind
  and must be globally unique on its own.
- **`capabilities` is a ceiling, not a request.** Every action's declared caps must be a subset
  of it; a violation refuses composition. It exists so a reader can see a plugin's maximum
  authority without reading its actions.
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
- **`essential: true` means the workspace cannot be drawn without you.** Only `core.shell` claims
  it. Attempting to disable an essential plugin returns
  `{ ok: false, denial: { rule: "refused", message: "essential" } }`, where the message is one
  member of the published refusal-class set (`essential`, `builtin`, the dependency classes, the
  data-version classes, `still_enabled`, …) — never free-form text.
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
- **`events` and `entry` are reserved.** Write them if you like; nothing reads them in this
  wave. They exist so the plane and the distribution mechanism can arrive without a manifest
  change.

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
| 4   | `forbidden`       | The caller lacks one of the action's declared caps.                                                                                                                                                                                                     |
| 5   | `invalid_args`    | The payload fails the action's `input` schema.                                                                                                                                                                                                          |
| 6   | `refused`         | The handler returned `{ refused }`, or the engine refused by class — e.g. `essential`, `builtin`, `still_enabled`.                                                                                                                                      |

Rule 3 is the same precedent as every workspace route. Finer per-node scoping arrives with the
permission waterfall (`docs/decisions/0011-permission-waterfall.md`); until then, a scoped token
can read and render, but cannot invoke.

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
performance bug and an audit-log flood.

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
toolbar. Nothing in the engine mentions "draw"; disable the plugin and the tool button
disappears and existing strokes render as placeholders, live, without a reload.

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

### The other three contribution kinds

- **`panels`** are leaves of the workspace tile tree. The workspace layout is itself a
  `TileLayout` whose leaf refs are `{ kind: "panel", panelId }` — the shell is a
  composition of panels (`core.shell.sidebar` and `core.shell.container-view` by default),
  rendered
  by the same `TileTree` component that renders a composition. One tree vocabulary everywhere.
- **`sections`** are rows in the sidebar stack, ordered by the manifest's `order` field. There
  is no user-visible section-order setting to read and no hardcoded section list to edit; the
  manifests _are_ the order.
- **`tools`** appear in the canvas toolbar.

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
  // index(), attendanceByContainer(), terminalsByContainer(), allTerminals()
  readonly principal: Principal; // who this device is — paint in this principal's colour
  readonly token: string; // this device's bearer: the grant a renderer opens its own pipe with
  readonly containerId: string | null; // the container the route is showing, null at the root
  navigate(uri: string): void; // a manifold:// URI, or an app path
  readonly viewport: ViewportHandle | null; // null until a container renderer is mounted
  readonly authoring: AuthoringHandle | null; // null when nothing can be authored into
  readonly assembly: AssemblyFacet; // read the roster: which plugins and contributions exist
}

interface ViewportHandle {
  centerOn(uri: string): void;
  viewport(): { x: number; y: number; zoom: number } | null;
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

### Marking your affordances

Every DOM control that invokes an action carries the action's full name:

```tsx
<button data-action="core.terminals.kill" onClick={…}>Kill</button>
```

This is not decoration. It is what lets a test, an agent, or a reviewer answer "what can this
pixel do?" without reading the handler, and the gate checks that every `data-action` literal
in the tree names an assembled action.

---

## 7. Assembly rules

Assembly happens at boot and on every enable/disable, on both the server and the web side.
It either produces a roster or throws an `AssemblyError` naming every offender. The word is
deliberate: **assembly** is the plugin-roster join, while a **composition** is a container whose
discipline is tiled. One word per concept (`AXIOMS.md` §Lexicon law, `REGISTRY.md` §Lexicon).

- **Collisions refuse; nothing ever shadows.** Duplicate plugin ids, action full names, panel
  ids, element types, or tool ids fail assembly loudly. There is no last-write-wins, no
  load-order precedence, and no silent override — a shadowed capability name is an authority
  bypass, so the answer is always a refusal that names both sides.
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

### The web registration channels (documented in full next wave)

A plugin's web half registers through four channels, and this guide does not yet specify them:
**renderers** (a discipline's container renderer — the projection registry key this wave renamed
from `padSurfaces` to `renderers`), **overlays** (chrome painted into a renderer's named slot,
like `attendance` and `spotlight`), **routes** (a browser path prefix, as `core.uri` claims
`/uri/`), and the **terminal facet** (the viewer `core.terminals` publishes for other renderers
to mount). They work, `packages/plugins/*` uses all four, and today they are registration-time
conventions rather than manifest contributions: they have no `contributes` counterpart, so the
roster cannot publish them, and one of them does not refuse a duplicate the way D5 requires.
That is a defect, not a design — it is fixed in the **defect-fix wave (wave F) of this same
change**, which gives each channel a manifest counterpart and a loud collision refusal, and
writes them up in this section. Until then: read `packages/web/src/assembly.ts` and
`packages/plugin/src/projection.ts` for the shapes, and do not rely on a duplicate being caught.

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
- `docs/decisions/0011-permission-waterfall.md` — where per-node authority is going.
- `docs/decisions/0012-event-plane.md` — where `contributes.events` is going.
