# Writing a manifold plugin

**Read this if you are an agent.** This file plus two live endpoints are the complete
onboarding surface; you should not need to read manifold's source to author a plugin.

```sh
curl -H "authorization: Bearer $TOKEN" http://localhost:7777/api/plugins    # the live roster: every plugin, its manifest, whether it is enabled, its actions
curl -H "authorization: Bearer $TOKEN" http://localhost:7777/api/protocol   # JSON Schemas for the wire, including every composed action's input and result
```

The roster is authoritative. If this document and `GET /api/plugins` disagree about what
exists, the endpoint is right and this document has a bug — report it. Prose never lists the
core plugins; `packages/plugins/*` and the roster do.

Everything above the foundation floor is a plugin. The floor is a machine-readable registry in
`AXIOMS.md` (fenced JSON, checked in both directions by `bun run verify:axioms`), not a
judgement call: identity and auth, protocol schemas, the plane transports, persistence, and
the registry itself. Anything else — the sidebar, the drawing tool, the terminal lifecycle,
view presence, the shell — is plugin territory, and the shipped ones are your worked examples.

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

A plugin is registered in exactly two places — `packages/server/src/composition.ts` and
`packages/web/src/composition.ts`. There is no discovery, no filesystem scan, no load order:
composition is data, and an unregistered package is not a plugin.

Your dependency budget is `@manifold/protocol`, `@manifold/scene`, `@manifold/sdk`, and
`@manifold/plugin`. Importing anything else from the tree — server internals, web internals,
another plugin — fails the gate.

---

## 2. The manifest

The manifest is **inert data**. It has no executable fields, nothing is interpolated, and the
server validates it with a strict schema (unknown keys are rejected).

```ts
import type { PluginManifest } from "@manifold/protocol";

export const manifest: PluginManifest = {
  id: "core.draw", // /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, max 64 chars
  version: "1.0.0",
  title: "Draw",
  description: "Freehand strokes on the canvas.",
  capabilities: ["scene:write"], // the union of everything this plugin's actions may need
  // essential: true,              // optional; disabling an essential plugin is refused
  contributes: {
    panels: [], // { id, title }        — a workspace tile leaf
    sections: [], // { id, title, order } — a sidebar section
    elements: [{ type: "draw", title: "Drawing" }], // a canvas element kind + its renderer
    tools: [{ id: "draw", title: "Draw" }], // a toolbar tool
    events: [], // reserved: the wave-2 event plane (ADR 0012). No consumer yet.
  },
  // entry: { web: "...", server: true }, // reserved: dynamic distribution, a later wave
};
```

Rules worth knowing before you write one:

- **The id must be dotted** — at least one `.` — and it namespaces everything you contribute.
  A panel `sidebar` contributed by `core.shell` is globally `core.shell.sidebar`.
- **Contribution ids are local names** (`^[a-z][a-z0-9-]*$`), except element `type`, which is
  a wire kind and must be globally unique on its own.
- **`capabilities` is a ceiling, not a request.** Every action's declared caps must be a subset
  of it; a violation refuses composition. It exists so a reader can see a plugin's maximum
  authority without reading its actions.
- **`essential: true` means the workspace cannot function without you.** Only `core.shell`
  claims it. Attempting to disable an essential plugin returns
  `{ ok: false, denial: { rule: "refused", message: "essential" } }`.
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
  caps: ["pads:write"], // MUST be ⊆ manifest.capabilities
  input: z.strictObject({ sessionId: z.string().min(1), name: z.string().min(1).max(120) }),
  result: z.strictObject({ sessionId: z.string(), name: z.string() }),
});
```

An action that REMOVES things may declare `cleanup: true`: the dispatcher then skips only
the `plugin_disabled` rung, so disabling your plugin refuses creation and administration
but never locks anyone out of deleting what already exists (D12; `core.terminals.kill` is
the canonical example). Caps and schemas still apply.

The server half supplies the handler:

```ts
// src/server.ts
export const serverDef = {
  manifest,
  actions: [rename, kill],
  handlers: {
    rename: async (ctx, args) => {
      if (ctx.broker.rename(args.sessionId, args.name) === "not_found") {
        return { refused: "no such terminal" }; // → denial rule "refused"
      }
      return { sessionId: args.sessionId, name: args.name };
    },
  },
};
```

`ctx` is the only host surface a handler sees — principal, auth context, store, rooms, broker.
Return the result value on success, or `{ refused: <message> }` to deny. The returned value is
validated against your `result` schema; a mismatch is a server error, not a denial, because it
is your bug.

### Calling one

```
POST /api/actions/core.terminals.rename
authorization: Bearer <token>
content-type: application/json

{"sessionId":"ts_abc","name":"build"}
```

The response is always 200 with an `ActionOutcome`:

```jsonc
{ "ok": true, "result": { "sessionId": "ts_abc", "name": "build" } }
{ "ok": false, "denial": { "rule": "forbidden", "message": "pads:write capability required" } }
```

Denials are outcomes, not HTTP errors — the same shape `POST /api/place` uses when it names
the placement rule that refused. From a client, `client.action(name, args)` on the SDK
`SessionClient` returns the same object.

### The denial ladder

Dispatch runs one monotonic ladder. The first rule that fires wins, and no later step can
argue an earlier denial back to allow:

| #   | Rule              | Fires when                                                                                                                               |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `unknown_action`  | No composed action by that full name.                                                                                                    |
| 2   | `plugin_disabled` | The owning plugin is disabled in this workspace. Skipped for actions declared `cleanup: true` (D12).                                     |
| 3   | `forbidden`       | The caller's token is **pad-scoped**. Actions are workspace-grade this wave; message is `scoped tokens cannot invoke workspace actions`. |
| 4   | `forbidden`       | The caller lacks one of the action's declared caps.                                                                                      |
| 5   | `invalid_args`    | The payload fails the action's `input` schema.                                                                                           |
| 6   | `refused`         | The handler returned `{ refused }` — a domain refusal, e.g. `essential`.                                                                 |

Rule 3 is the same precedent as `POST /api/place` and every workspace route. Finer per-node
scoping arrives with the permission waterfall (`docs/decisions/0011-permission-waterfall.md`);
until then, a scoped token can read and render, but cannot invoke.

---

## 4. Which plane does my feature belong to?

This is the question that decides whether you write an action at all. Answer it before you
write code; getting it wrong produces state that one principal can see and another cannot,
which is the bug class the axioms exist to prevent.

| Plane               | Rule                                                                                     | Mechanism                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Action**          | Legality or effect depends on state the actor cannot see, or authority it does not hold. | A registered action. `POST /api/actions/:name`.             |
| **Document**        | A per-element edit whose worst-case merge outcome a human would accept.                  | The Yjs scene document.                                     |
| **Presence**        | It dies with the connection.                                                             | The presence payload (cursor, selection, viewport, `view`). |
| **Channel traffic** | A continuous stream — PTY bytes, cursor motion, a live drag.                             | Existing channel frames or local echo.                      |

The continuous-stream row has a corollary you must obey: **an action fires at the commit point
of a gesture, never per frame.** Dragging a workspace divider paints locally for every pointer
move and dispatches exactly one `core.layout.set` on pointerup. A per-frame action is a
performance bug and an audit-log flood.

State that belongs to none of the four is **unplaned**, and unplaned state is a bug. There is
one legitimate escape: genuinely device-local presentation state (a remembered viewport, "this
browser prefers the sidebar collapsed"), which must be registered in the `AXIOMS.md`
device-local register. `verify:axioms` fails on any `localStorage` key that is not listed
there.

---

## 5. Contributions, with `core.draw` as the worked example

`core.draw` is deliberately the smallest complete plugin: it contributes one element renderer
and one tool, and it has no server half at all, because drawing a stroke is a document-plane
edit.

The web half exports the renderers, keyed by the ids the manifest declared; the shape is the
one `packages/web/src/composition.ts` registers, so let inference type it rather than naming a
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

### The other three contribution kinds

- **`panels`** are leaves of the workspace tile tree. The workspace layout is itself a
  `TileLayout` whose leaf surfaces are `{ kind: "panel", panelId }` — the shell is a
  composition of panels (`core.shell.sidebar` and `core.shell.pad-view` by default), rendered
  by the same `TileTree` component that renders a pad. One tree vocabulary everywhere.
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
  client: SessionHandle; // the SDK surface: action(), place(), machines(),
  // padTree(), padPresence(), terminals()
  navigate(uri: string): void; // a manifold:// URI, or an app path
  viewport: PadViewportHandle | null; // null until a pad view is mounted
}

interface PadViewportHandle {
  centerOn(uri: string): void;
  viewport(): { x: number; y: number; zoom: number } | null;
}
```

That is the whole host surface, and it is deliberate: no store, no room map, no React context
from `packages/web`, nothing that would have to be re-plumbed if plugin code were later moved
behind an isolation boundary. If you need data the host does not expose, add a typed wrapper to
the SDK — never a direct `fetch` against a route, and never a deep import.

Addressing: `manifold://` URIs are the canonical way to refer to anything —
`manifold://pad/<padId>`, `.../element/<elementId>`, `.../tile/<tileId>`,
`manifold://terminal/<sessionId>`, `manifold://principal/<id>`, `manifold://plugin/<pluginId>`,
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
in the tree names a composed action.

---

## 6. Composition rules

Composition happens at boot and on every enable/disable, on both the server and the web side.
It either produces a roster or throws a `CompositionError` naming every offender.

- **Collisions refuse; nothing ever shadows.** Duplicate plugin ids, action full names, panel
  ids, element types, or tool ids fail composition loudly. There is no last-write-wins, no
  load-order precedence, and no silent override — a shadowed capability name is an authority
  bypass, so the answer is always a refusal that names both sides.
- **Action caps must be a subset of manifest capabilities**, checked at composition, not at
  dispatch.
- **Enable/disable is hot and workspace-global.** `core.plugins.setEnabled` (cap
  `plugins:manage`) flips a server-persisted flag and broadcasts the new roster on a
  connection-level session frame; every client rebuilds live. No reload, ever.
- **Disabled and unknown contributions render inert placeholders that name the plugin** — on
  canvases and in the workspace tree alike. A placeholder in the workspace tree carries a
  remove control that commits the pruned layout. Disabling a plugin must never brick a
  surface, and layout writes referencing an unknown panel are _accepted_ for exactly this
  reason.
- **Disabling kills creation and administration, never cleanup.** Disabling `core.terminals`
  refuses new terminal opens and its administrative actions, but existing sessions stay
  attachable and killable. Users are never locked out of removing things.

---

## 7. What the gate checks

`bun run verify:axioms` runs in `bun run gate`. It has a static half and a browser half; these
are the checks that will fail _your_ plugin:

- Both composition files compose without a `CompositionError`, and every panel id referenced by
  the default workspace layout exists.
- **Import boundary** (walked with the TypeScript parser, not regex): floor files must not
  import `@manifold-plugin/*` — the two `composition.ts` files are the only exceptions — and
  plugin packages may import only `@manifold/{protocol,scene,sdk,plugin}`.
- **Every `data-action` literal names a composed action.**
- **Every `localStorage` key in `packages/{web,plugins}` is listed in the `AXIOMS.md`
  device-local register.**
- Every `packages/plugins/*` directory is registered per the halves it exports, and every
  composed definition maps back to a package.
- Every floor glob in the registry matches at least one file (the registry cannot rot silently).
- The `/api/…` route literals in the server equal the documented allowlist — a bespoke feature
  route added outside the action door fails the gate by construction.
- Every `SceneElementSchema` member type is either an engine floor kind or a composed element
  type.
- In the browser: `/api/protocol` and `/api/plugins` agree with the composition; hot
  enable/disable takes effect without a reload; an action invoked over the SDK is observed in
  the DOM and vice versa; the denial ladder returns the documented rules.

## Further reading

- `AXIOMS.md` — the axioms, the taxonomy, the foundation registry, the device-local register,
  and the roadmap.
- `docs/CONTRACTS.md` — the wire: routes, frames, capabilities, presence payloads.
- `docs/decisions/0010-plugin-engine-and-action-plane.md` — the trust model and why the action
  envelope looks like this.
- `docs/decisions/0011-permission-waterfall.md` — where per-node authority is going.
- `docs/decisions/0012-event-plane.md` — where `contributes.events` is going.
