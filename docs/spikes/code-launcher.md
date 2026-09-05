# code-launcher — a third-party launcher plugin against v0.6.2 (spike, evidence for #160)

Status: measured 2026-09-05 against manifold `main` @ `8466628` (v0.6.2, protocol 21) on
`dev-01`, the one enrolled spoke of the operator's fleet, with bun 1.3.13. Every manifold fact
below is tagged the way `atyrode/babel`'s `docs/manifold-transition.md` tags its own:
`exists` (in code, cited `path:line` at that revision), `declared` (named in a ratified manifold
document, not implemented), `absent` (searched for, not found), plus one tag this record adds —
**`measured`** (a number a script or a browser produced here, reproducible from the files in
`docs/spikes/code-launcher/`).

**The plugin commit under this record is throwaway and is never merged.** It exists so that the
question "what can a stranger's launcher plugin do at v0.6.2, and what does it hit" is answered
with numbers rather than by reading. Only this file (and its directory) is a candidate for
landing, in a PR of its own. Nothing here is a changelog entry: a spike record is not a shipped
change.

Inputs this spike was built from: the four audit reports for `atyrode/code`'s transition
(manifold's plugin/terminal contracts at v0.6.2, code's surface inventory, the launch
environment on the spoke, and how babel prepared), and the operator's six settled decisions for
code (D1 out-of-tree loading as babel's D1; D2 launch authority on the spoke behind a headless
`code launch --selection`, interim = a manifold terminal typed into, end state = `terminal_open`
carrying a command; D3 projections spoke→hub through `code.*` doors; D4 end state = a
composition-shaped `code.launchpad`, interim = a `code.launcher` panel; D5 secrets never enter
manifold; D6 the Babel-worker half of code is out of scope). The spike tests D2's interim and
D4's two interim shapes. It does not re-derive anything about D1, D3, D5 or D6.

---

## 1. Purpose

Three questions, all about the interim (before manifold's dynamic loading, before a command field
on `terminal_open`):

1. Can a panel plugin, using only documented doors, open a terminal on a chosen machine, in a
   chosen cwd, next to the thing the reader is looking at, and type a command into it — and how
   reliably?
2. Which of D4's two interim shapes is viable today: a panel that places into the composition in
   view, or a panel that creates a composition, navigates there and places?
3. Where does A3 ("a stranger's agent can author a working plugin against documented interfaces
   without reading the engine", `AXIOMS.md:53-61`) break — which engine files did this author
   have to read, and why?

## 2. Setup

- A **local** hub, never the production hub: `bun --watch packages/server/src/main.ts` with
  `MANIFOLD_DATA_DIR=/tmp/manifold-spike-data MANIFOLD_PORT=7799 MANIFOLD_BIND=127.0.0.1
MANIFOLD_PUBLIC_URL=http://127.0.0.1:7799 MANIFOLD_ANNOUNCE_KEY=1`. The server auto-spawns a
  local machine agent (`spawnAgent`, `packages/server/src/config.ts:105`), which is the one row
  in the roster. **Port 7799, not the documented 7777**: on this host Caddy still forwards the
  public vhost to `127.0.0.1:7777`, so a throwaway hub there would have answered public traffic.
  `MANIFOLD_PORT` is honoured (`packages/server/src/config.ts:30-36,86`); the consequence is that
  `bun run dev:web` cannot be used, because vite's proxy target is a literal
  (`packages/web/vite.config.ts:96-99`), so the browser half was served from `bun run build:web`
  by the 7799 server itself (`MANIFOLD_WEB_DIST`, `config.ts:104`), 1.9 s per rebuild.
- The owner key was generated into `<data>/owner.key` (`config.ts:46-71`) and read from there by
  the scripts; it is never printed here. In the browser the `#key=` fragment (`main.ts:278-282`,
  dev-only opt-in) leads to the identity gate, which mints a **fresh human principal** — so the
  browser half of this spike ran as a principal with no stored layout, and the SDK half ran as
  the owner. That difference turned out to matter (§4.1).
- `docs/spikes/code-launcher/measure.ts` is the SDK harness (imports by relative path, as
  `s126-dockview` does, because workspace packages are linked only into the packages that
  depend on them); it writes `measurements.json`. Ten trials per race mode
  (`SPIKE_TRIALS=10`). The shell the agent spawns is `$SHELL` = zsh with oh-my-zsh, which is
  exactly what a `manifold-agent` PTY on `dev-01` runs today.

## 3. Measurements over the SDK

### 3.1 (a) The roster — `core.machines.list`

`measured`: one row; row keys `color`, `id`, `name`, `online` — exactly `MachineSummarySchema`
(`packages/protocol/src/http.ts:322-338`; `revoked` is absent while not revoked). There is no
`lastSeenAt`, no capabilities, no PATH or binary inventory: a launcher cannot learn from the
roster whether `code` or `omp` exists on a machine (issue #153 territory).

### 3.2 (b) A tile-placed terminal: env, cwd, geometry

`measured`, one terminal via `SessionClient.openTerminal({ placement: "tile", cwd: "/tmp",
machineId })` on a fresh composition:

| Fact                                | Value                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `terminal_open` → `terminal_opened` | 24 ms (18–32 ms across the harness's runs)                                                      |
| home                                | the composition the channel was joined to (`terminal.containerId === containerId`)              |
| server-authored leaf                | `root` (an empty composition's first terminal fills the root leaf)                              |
| `$PWD` inside the PTY               | `/tmp` — **cwd honoured**                                                                       |
| `MANIFOLD_*` env keys (names only)  | `MANIFOLD_CONTAINER`, `MANIFOLD_TOKEN`, `MANIFOLD_URL` — three, not four                        |
| `$SHELL` / `$TERM`                  | `/run/current-system/sw/bin/zsh` / `xterm-256color`                                             |
| `TerminalInfo` keys                 | `cols containerId controllerId createdBy exitCode id machineId name rows status` — no placement |

`MANIFOLD_ELEMENT` is absent for a tile-placed terminal by construction
(`packages/server/src/terminal-broker.ts:535-543`: `...(placement === "tile" ? {} : { MANIFOLD_ELEMENT })`).
Everything else in the PTY's environment is the agent process's own minus every `MANIFOLD_*`
(`packages/agent/src/terminal.ts:132-144`), so on the spoke the wrapper-computed `CODE_*` /
`OMP_AUTH_BROKER_*` environment is reproduced by the login shell itself, not by manifold — which is
what D2 relies on. There is no client-side env field anywhere on the open path
(`packages/protocol/src/session.ts:192-210`; `machine.ts:76-86`) — `absent`.

**The HTTP creation door creates nothing** (`measured`): `POST /api/actions/core.terminals.open`
with a full, valid request answered `{ ok: true, result: {} }` and the terminal count before and
after was 1 and 1. The action is the authorization rung only (`packages/plugins/terminals/src/index.ts:86-113`); the PTY is born by the session frame. A2's "reachable identically over the UI and over the API" does not hold for terminal creation over HTTP — a headless caller with a bearer and no socket cannot make one.

### 3.3 (c) The keystroke race

The question D2's interim turns on: after `terminal_opened`, when may the plugin type? Three
moments, ten trials each, one fresh terminal per trial, typing `echo RACE_<n>_"OK"` (so the
result `RACE_<n>_OK` can never be confused with the tty's echo of the keystrokes):

| Moment typed at                                    | result seen | echoed **before** the prompt | painted **twice** | first frame (ms)  | ready signal (ms) | input sent (ms)   | result (ms) |
| -------------------------------------------------- | ----------- | ---------------------------- | ----------------- | ----------------- | ----------------- | ----------------- | ----------- |
| immediately after `terminal_opened`                | 10/10       | **10/10**                    | **10/10**         | 16–50 (med 33)    | —                 | 12–36 (med 20)    | 359–428     |
| after the first non-empty output frame             | 10/10       | **10/10**                    | **10/10**         | 275–334 (med 306) | —                 | 280–335 (med 306) | 330–403     |
| after the line editor signals ready (`ESC[?2004h`) | 10/10       | 0/10                         | 0/10              | 260–339 (med 305) | 292–376 (med 345) | 292–377 (med 345) | 323–407     |

Read it this way:

- **Nothing is lost** in any mode. Bytes typed before the shell reads land in the kernel's tty
  queue and zsh's line editor consumes them once it starts — so the 0/10 "lost" is a property of
  the tty, not of manifold.
- **Everything typed early is painted twice and out of order**: the tty echoes the line in
  cooked mode at ~20–35 ms (that echo IS the "first frame" in the immediate mode — the first thing
  the PTY emits is the launcher's own keystrokes), zsh then prints its `%` end-of-line marker,
  its OSC title, the prompt, and repaints the pending line with syntax highlighting before
  running it. On screen: the command above the prompt, then the prompt, then the command again.
- **"First output frame" is not a readiness signal.** In the after-first-frame mode the first
  frame is zsh's inverse-`%` marker at ~305 ms, still 30–40 ms before the prompt; typing there is
  indistinguishable from typing immediately.
- **The one signal that works is the shell's own**: bracketed-paste ON (`ESC[?2004h`), emitted by
  zsh's ZLE and bash's readline when they start reading a line, at 292–376 ms after open here
  (258–362 ms in an earlier, quieter run of the same harness).
  Typing after it produced 0/10 artifacts. It is shell-specific (plain `sh` never sends it), it is
  a heuristic over the byte stream, and nothing in the protocol names it: `terminal_event` kinds
  are `opened exited controller_changed resized parked renamed`
  (`packages/protocol/src/session.ts:430`) — there is no "the program inside is reading".
- The whole gesture, open to command output, is **~0.33–0.39 s** on the target spoke either way;
  the readiness wait costs nothing extra because the shell was not ready before that anyway.

### 3.4 (d) A canvas-born terminal, then `core.space.place`

`measured`, a terminal opened on a **canvas** channel with no `placement`, then moved by the
placement door. Each row is one HTTP round trip on `core.space.place`, followed by a read of
`core.terminals.listAll` and of the composition's live layout:

| Step                                                | ms  | outcome                                                  | home afterwards               | leaves for this terminal in the composition | canvas elements |
| --------------------------------------------------- | --- | -------------------------------------------------------- | ----------------------------- | ------------------------------------------- | --------------- |
| `terminal_open` (canvas, no placement)              | 18  | born into **a fresh solo composition**, `unplaced: true` | its solo composition          | 0                                           | 0               |
| place → `tile` in composition, `targetTileId: null` | 19  | `{ op: "add_tile", tileId: "root" }`                     | **the composition** (rehomed) | 1                                           | 0               |
| place again, same destination                       | 5   | `{ op: "add_tile", tileId: "t1" }`                       | the composition               | **2**                                       | 0               |
| place → `canvas` `{x:100,y:100}`                    | 8   | `{ op: "portal", elementId }`                            | the composition               | 2                                           | 1               |
| place → `tile` in an unknown container              | 5   | refused `unknown_container: terminal -> composition`     | unchanged                     | 2                                           | 1               |
| place an unknown terminal                           | 3   | refused `unknown_ref: terminal -> composition`           | unchanged                     | 2                                           | 1               |
| place → `unplaced`                                  | 8   | `{ op: "unplace", removed: 1 }`                          | the composition               | 2                                           | 0               |

Facts a launcher author needs from this:

- A launch that opens on a canvas channel and then places is **two round trips with a hole
  between them**: after the first, a terminal exists in a solo composition nobody references
  (legal per the index-visibility rule; it sits at the index's top level as `unplaced`). If the
  second fails, that is what the user is left with. Opening on the composition's own channel with
  `placement: "tile"` (§3.2) is one round trip and has no hole — it is the shape to use.
- `core.space.place` **rehomes** a terminal into the composition it is tiled into (the
  `terminal_bound` event's semantics) — a tile is not a reference the way a canvas portal is.
- **Placing the same terminal twice into the same composition yields two leaves** of one PTY. No
  refusal, no idempotence; a double-click on Launch would do exactly this. `[design]`.
- `unplaced` removes canvas portals but leaves the composition's own leaves alone (the terminal
  lives there), so "unplaced" after a tile placement is not the reverse of it.
- Refusals are classes followed by `ref -> container`, and the container kind in the message is
  derived from the destination's shape, not from what exists (`unknown_container: terminal ->
composition` for an id that names nothing).

### 3.5 (e) A terminal leaf in the WORKSPACE tile tree

`measured`, `core.space.setLayout` with a two-leaf row `[panel core.shell.sidebar | X]`:

| X                                                                                                | outcome                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `{ kind: "terminal", terminalId }`                                                               | refused `workspace leaves hold panels, not "terminal"`  |
| `{ kind: "container", containerId }`                                                             | refused `workspace leaves hold panels, not "container"` |
| `{ kind: "text", elementId }`                                                                    | refused `workspace leaves hold panels, not "text"`      |
| `{ kind: "panel", panelId: "code.launcher-spike.launcher" }` (a panel nobody had registered yet) | **accepted** `{ ok: true }`                             |

The refusal is one hand-written string comparison over a union that also holds the three
refused kinds (`packages/plugins/shell/src/server.ts:107-110`; `TileRefSchema`,
`packages/protocol/src/layout.ts:85-108`). D4's end state — a terminal tile above the launcher's
dials in ONE tree — is therefore not reachable through the workspace tree at v0.6.2, full stop;
the interim below gets the picture by putting the launcher in the workspace tree and the
terminals in a composition's tree, two trees drawn as one view.

### 3.6 Two more things the browser half depended on

- **The controller lease is per principal, not per connection** (`measured`): a terminal opened by
  connection A of the owner, A closed, connection B of the same principal attached and typed —
  input accepted, result echoed, no `not_controller`. Code: `terminal-broker.ts:857` compares
  `controllerId` with `channel.auth.principal.id`. Doc: `docs/CONTRACTS.md:797-800` says "a lease
  is held BY a connection". The code is what let a panel open a throwaway channel, type, close it,
  and leave the reader in the composition able to type — and it contradicts the sentence a
  third-party author would have read first. `[design]`, docs-vs-code.
- **Every launch mints a durable agent principal** (`measured`): one `kind: "agent"` principal
  per terminal opened — `core.access.listCredentials` held 121 of them, named by UUID, after the
  121st terminal this spike had opened, and the Sessions section counted them as "inactive
  identities" (120, then 125 after the next launches); a live launch shows as one more live
  "agent" row beside the human (shot 3, shot 4). This is the terminal-scoped token
  `docs/CONTRACTS.md:1415-1424` documents, seen from the launcher's seat: a launcher used daily
  would put hundreds of anonymous identities into the one place people go to withdraw a
  credential. `[design]`.

## 4. The throwaway plugin

`packages/plugins/code-launcher-spike` — `code.launcher-spike`, 438 lines across three files
(`src/index.ts` manifest 43, `src/launch.ts` the gesture 161, `src/web.tsx` the panel 234), no
server half, no actions, `capabilities: []`, no stylesheet (a plugin's skin needs a
`cssFamilies` registry row, `docs/PLUGINS.md:87-92`, and a spike must not touch `REGISTRY.md`).
What it does: three dependent dials (lane → model → thinking) off a hard-coded five-row slice of
code's catalog, a machine picker over `host.client.machines()` through `usePolledResource` on
`host.topics.machines` (the pattern `packages/plugins/machines/src/web.tsx:35-45` uses), and two
launches. Each launch opens a throwaway `SessionClient` into the target composition with
`host.token`, `openTerminal({ placement: "tile", cwd: "/tmp", machineId })`, attaches, waits for
`ESC[?2004h` (fallback: 400 ms of silence behind a prompt glyph; hard cap 5 s), waits up to 800 ms
more for the viewer's refit (`terminal_event resized`), types `echo LAUNCH lane=… model=…
thinking=…`, detaches, closes the channel. The dials, the machine list and the per-phase timings
are drawn in the panel.

### 4.1 Registering it

`docs/PLUGINS.md:40-42`: "registered in exactly two places". `measured`: five files changed —
`packages/server/src/assembly.ts` and `packages/web/src/assembly.ts` (the two), plus a
`"workspace:*"` dependency row in each of `packages/server/package.json` and
`packages/web/package.json` (without which the two imports do not resolve) and `bun.lock`; the
root `package.json` `check` script enumerates packages by hand and was left alone, so `bun run
check` never typechecks this package (`tsc -p packages/plugins/code-launcher-spike` does, and is
green). The running `--watch` server crashed on the assembly edit until `bun install` had run.
`[improvement]` on the doc sentence.

The manifest declares a seat (`order: 150, ratio: 0.3`, between the shell's 100 and 200). The
browser's fresh principal got it without any layout edit (shot 1). The owner — who had written a
layout in §3.5 — did not: `GET /api/layout` for the owner answers `[core.shell.sidebar,
core.shell.container-view]` and nothing else (`packages/server/src/http.ts:288-306`: stored tree
wins over the composed default). That is ADR 0017 §3 working as documented (`docs/PLUGINS.md:683-688`),
and it is also what every existing reader of a workspace experiences when a plugin is installed
after they first arranged it: **nothing appears**, and there is no in-product affordance that says
a new seat is available. `[improvement]`.

### 4.2 The two interim shapes, in the browser

Screenshots are in `docs/spikes/code-launcher/`, taken by a real Chromium against the 7799
server's built bundle at 1440×900.

- `shot-1-fresh-seat-canvas-routed.png` — the fresh principal's default: sidebar | launcher |
  container view, on a canvas. The dials read `fast / anthropic/claude-haiku-4.5 / minimal /
local`; the command preview reads the echo line. **"Launch here" is disabled** with the tooltip
  "Open a composition first: the workspace tree cannot hold a terminal leaf" — the panel reads
  `useContainerRoute().routedDiscipline` and refuses to place into a canvas. "Launch in new
  composition" is enabled.
- `shot-2-launch-here.png` — after navigating to an empty composition (`project-alpha`) and
  pressing "Launch here": the terminal fills the composition's root leaf, its title chip says
  `local`, the buffer shows the prompt `➜ /tmp`, the typed
  `echo LAUNCH lane=fast model=anthropic/claude-haiku-4.5 thinking=minimal`, its output line,
  and a fresh prompt — no double paint, no stray `%`. The panel's log:
  `terminal_opened in 25 ms · shell ready (bracketed_paste) at 327 ms · viewer refitted the tile
at 443 ms — typing`.
- `shot-3-launch-new-composition.png` — dials changed to `balanced / deepseek/deepseek-v3.2 /
medium`, "Launch in new composition": `core.index.createContainer` (27 ms), `host.navigate("manifold://container/<id>")`,
  then the open on the new room. The view is the new composition, named `code balanced/deepseek-v3.2`,
  one terminal, clean output. Log: `composition in 27 ms · terminal_opened in 91 ms · shell ready
at 645 ms · viewer refitted at 577 ms`. Note the order: on a cold room the composition view
  mounted and refitted the tile **before** zsh was ready; on a warm room (shot 2) the refit came
  116 ms **after** the prompt. The Sessions section shows two live `agent` rows, one per launched
  terminal.
- `shot-4-terminals-above-launcher.png` — the D4 picture, interim style: the fresh principal's
  workspace re-arranged to `sidebar | (container view / launcher)` through `core.space.setLayout`
  (one write; the live tree did not repaint within 1.5 s, a reload showed it), `project-alpha`
  in view, a second launch with `deep / anthropic/claude-opus-4.1 / high`. Two terminal tiles
  side by side above the dials, both wrapping cleanly at their tile width. Log:
  `terminal_opened in 24 ms · shell ready at 355 ms · viewer refitted at 410 ms — typing`.

**The refit artifact** (`measured`, before the 800 ms refit wait was added): `terminal_open`
requires `cols`/`rows` (`session.ts:200`), the opener cannot know the tile the composition will
hand the terminal, and the mounting viewer refits it — `terminal_event { kind: "resized" }` at
403–443 ms in the warm cases. A line typed before that refit was repainted by zsh at the new
width and came out garbled (a wrapped `thi` / `echog=high` with stray cursor cells, visible in an
earlier take). Waiting for the refit removed it in every later launch. In D2's end state
(`terminal_open` carrying the command) no keystroke precedes the viewer, so this disappears.

### 4.3 Timings, all launches from the browser (ms after `terminal_open`)

| Launch                          | `terminal_opened` | shell ready (`ESC[?2004h`) | viewer refit      |
| ------------------------------- | ----------------- | -------------------------- | ----------------- |
| here, warm room (shot 2)        | 25                | 327                        | 443               |
| new composition, cold room (3)  | 91                | 645                        | 577               |
| here, warm room (shot 4)        | 24                | 355                        | 410               |
| here, warm room (earlier takes) | 33 · 41 · 57 · 59 | 414 · 371 · 358 · 385      | 432 · — · 403 · — |

## 5. The A3 ledger: engine files read outside `docs/`

`docs/PLUGINS.md:3-4` promises that the guide plus two live endpoints are the whole onboarding
surface. Every row below is a file under `packages/` this author opened to get the plugin (or the
harness that measures it) to work, and why. The first group is the A3 violation proper — reads
without which the **plugin** could not have been written from the docs; the second group was
needed only for the **measurement harness** and the local setup, which a plugin author would not
need.

**Needed to author the plugin (A3 violations):**

| File                                                                     | What the docs did not say                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/plugin/src/host.ts:52-115,154-156,359-366,397`                 | `HostServices.client` is a `SessionHandle` with **no `openTerminal`**; `host.authoring` is null unless the mounted renderer publishes one. Nothing in `docs/PLUGINS.md` §Host services says how a PANEL births a terminal. |
| `packages/plugins/compositions/src/composition-view.tsx:180-182,512-549` | The only worked example of a plugin opening a terminal: `new SessionClient({ url: sessionUrl(), containerId, token: host.token })` plus `placement: "tile"`, and how the renderer publishes `createTerminal` upward.       |
| `packages/web/src/workspace.tsx:734-738`                                 | Why `authoring` was null for the panel: it is `workspace?.onCreateTerminal ?? compositionCreate?.create` — the mounted renderer's, never a panel's.                                                                        |
| `packages/plugin/src/instance.ts:129-132`, `hooks.ts:198-204`            | `sessionUrl()` exists and is exported from `@manifold/plugin/hooks`; `docs/CONTRACTS.md:1782` names it in passing, `docs/PLUGINS.md` never.                                                                                |
| `packages/plugin/src/container-route.ts:41-60,78-84`                     | `useContainerRoute().routedDiscipline` is how a panel learns whether the viewed container can hold a tile; undocumented for panels.                                                                                        |
| `packages/sdk/src/session-client.ts:1136-1184,1195-1214`                 | `openTerminal`'s options and correlation (`terminal_opened.ref`), `attachTerminal`, `sendTerminalInput`, and the event names a capture listens to. The SDK is in the dependency budget but has no reference page.          |
| `packages/protocol/src/session.ts:192-210,401-436`                       | `terminal_open` has no command field and requires geometry; `terminal_event` kinds (to wait for `resized`).                                                                                                                |
| `packages/plugins/terminals/src/index.ts:86-113`                         | `core.terminals.open` is authorization only — confirmed by the doc comment after `measured` (§3.2) showed it creates nothing.                                                                                              |
| `packages/server/src/terminal-broker.ts:857`                             | The lease is per principal (the doc says per connection, §3.6); without this the panel could not have known a closed throwaway channel leaves the reader in control.                                                       |
| `packages/plugins/machines/src/web.tsx:35-45`, `src/index.ts:23-62`      | The `usePolledResource` call shape (`key`, `initial`, `topics`, `events`) — `docs/PLUGINS.md:981-989` names the hook but not its signature.                                                                                |
| `packages/plugins/debug/{package.json,tsconfig.json,src/index.ts}`       | Package boilerplate: exports map, tsconfig `include` of `css-modules.d.ts`, a door-less manifest with every `contributes` key present.                                                                                     |
| `packages/web/src/plugin-host.tsx:121-171,1053-1073`                     | `WebPluginDef`'s shape (what a web half exports) and what `host.navigate("manifold://container/…")` becomes.                                                                                                               |
| `packages/server/src/plugin-host.ts:368-370`                             | `ServerPluginDef` for a browser-only plugin (`actions: [], handlers: {}`).                                                                                                                                                 |
| `packages/server/package.json`, `packages/web/package.json`              | The dependency rows §4.1 counts.                                                                                                                                                                                           |

**Needed only for the harness and the local setup (not A3):**

| File                                                                                                                                   | Why                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/server/src/config.ts:30-36,46-71,86-109`, `main.ts:278-282`                                                                  | Port/bind/data-dir/announce envs and where the owner key lives.                          |
| `packages/web/vite.config.ts:86-99`                                                                                                    | The proxy literal that ruled out `dev:web` on a non-7777 hub.                            |
| `packages/server/src/http.ts:288-306`                                                                                                  | `GET /api/layout` to prove §4.1's owner-vs-fresh-principal difference.                   |
| `packages/testkit/src/spawn.ts`, `e2e/helpers.ts`, `e2e/terminal.test.ts`                                                              | How e2e spawns, connects and captures a terminal (the harness copies its capture shape). |
| `packages/protocol/src/{layout.ts:85-108,227-258, placement.ts:602-799, http.ts:214-250,322-342, plugin.ts:510-556, machine.ts:69-93}` | Wire shapes for §3.4/§3.5 requests and for reading results without casting.              |
| `packages/plugins/shell/src/{server.ts:85-192,index.ts:60-81,154-160}`                                                                 | The refusal §3.5 measures and the seat numbers §4.1 sits between.                        |
| `packages/agent/src/terminal.ts:121-144`                                                                                               | Why the PTY env is what §3.2 measured.                                                   |
| `packages/server/src/assembly.ts`, `packages/web/src/assembly.ts`                                                                      | The two registration files — documented reads (`docs/PLUGINS.md:40-42,1103`).            |

Fourteen rows, nineteen files, in the first group. The count is the finding: the docs describe how a plugin
contributes chrome and doors; they do not describe how a plugin **acts on the channel plane**
(open a terminal, attach, type), and every third-party launcher is a channel-plane plugin.

## 6. Verdict on the interim

Both D4 interim shapes work at v0.6.2, end to end, with one gesture each, and they share every
line of the launch routine; the difference is one action plus a `navigate`:

| Shape                                             | Round trips (plugin → server)                                      | Where the terminal lands                                                   | Failure hole                                                                   | Fit for D2's interim                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Panel + place into the composition in view**    | 1 (`terminal_open` with `placement: "tile"`), then channel traffic | the composition the reader is looking at; root leaf if empty, else a split | none: a refused open leaves nothing; disabled on a canvas                      | **Yes.** Warm room: prompt at ~330–410 ms, refit before or ~50 ms after.   |
| **Panel + create composition + navigate + place** | 2 (`core.index.createContainer`, `terminal_open`) + a route change | a new composition named for the dials                                      | an empty composition survives a refused open (cheap, visible, deletable)       | Yes, and the better default when the reader is on a canvas or at the root. |
| Canvas-born + `core.space.place` (§3.4)           | 2 with a hole                                                      | rehomed into the destination                                               | an unplaced solo terminal if the place fails; double-placing duplicates leaves | No — never the shape to build on.                                          |

Recommendation for `atyrode/code`'s interim (`code.launcher`): **one panel, both buttons** —
"Launch here" enabled when `routedDiscipline === "composition"`, "Launch in new composition"
always; the composition's own channel, `placement: "tile"`, type after `ESC[?2004h` **and** after
the viewer's refit (bounded); never the canvas-born path. The D4 picture (terminals above the
dials) is reachable today only as the reader's own arrangement of two trees (shot 4); the plugin
cannot write it for them — the workspace tree refuses everything but panels, and a plugin holds no
write on the workspace tree but `core.space.setLayout` on the caller's own principal, which a
launcher should not be doing on a reader's behalf.

What this settles about the D2 interim: typing `code launch --selection …` into a fresh manifold
PTY is workable on the spoke, on the condition that the plugin waits for the shell's line-editor
signal; the spoke's login shell reconstructs code's whole environment; the cwd is honoured; and
the gesture is ~0.35 s. What it does not settle: the readiness signal is a heuristic over bytes
with no protocol name and no answer for `sh`, and every launch mints a durable agent identity.
Both are on the list below.

## 7. Gaps, as candidate issue titles

Existing coverage is marked; everything else is new. Class tags: `[prerequisite]` code cannot
reach a step without it; `[design]` a contradiction or smell worth raising regardless;
`[improvement]` general.

1. `[prerequisite]` **`terminal_open` carries a command (argv, or a command line the shell runs) so a PTY can exec a program without keystrokes.** `absent` on the wire (`session.ts:192-210`, `machine.ts:76-86`); the agent always spawns `$SHELL` (`packages/agent/src/terminal.ts:121-124`). D2's end state. Adjacent to #156 (job primitive, explicitly no PTY) — this is its PTY-shaped sibling, not a duplicate.
2. `[prerequisite]` **A composition-shaped discipline that can host plugin UI beside terminal tiles in one tree** — D4's `code.launchpad`. Today: workspace leaves refuse terminals (§3.5), composition leaves hold `terminal | container | text` and no panel (`layout.ts:85-108`), and a third-party tile-tree discipline inherits #134's twelve literals. New: `[prerequisite]` on top of #134.
3. `[prerequisite]` **A panel-level door for birthing a terminal into a chosen container** (`HostServices.authoring` for the target container, or `openTerminal` on `SessionHandle`), so a panel does not open a second room channel with the raw bearer to do what the composition renderer does (§5, first row). `absent`; today's route is undocumented, and it works only because the SDK's connection pool folds that second channel onto the browser's own socket.
4. `[design]` **Terminal creation is not reachable over HTTP; `core.terminals.open` authorizes and creates nothing** (§3.2, `measured`). A2 contradiction for the one capability a launcher exists for. Not covered by #151–#184.
5. `[design]` **A "the program inside is reading" signal on the terminal channel**, or at least a documented readiness contract — today the only signal is bracketed-paste-on inferred from bytes, absent for `sh`, unnamed in `terminal_event` (`session.ts:430`); typing at `terminal_opened` or at the first frame paints the command twice 10/10 (§3.3). Becomes moot for the launcher once (1) lands; stays real for any agent that types into a shell.
6. `[design]` **The controller lease is documented as per-connection and implemented as per-principal** (`docs/CONTRACTS.md:797-800` vs `terminal-broker.ts:857`; `measured` §3.6). Fix the sentence or the check; the spike's panel depends on the check.
7. `[design]` **Every terminal mints a durable agent principal that outlives the terminal** — 121 anonymous `agent` rows after 125 launches, all visible in Sessions as "inactive identities" (§3.6). A launcher makes this a daily flood. Reap on kill/exit, or keep terminal grants out of the principals list.
8. `[design]` **`core.space.place` of a terminal into a composition it already tiles adds a second leaf** (§3.4). Refuse as `already_placed`, or make it a move.
9. `[design]` **`terminal_open` requires a geometry the opener cannot know when the container places the leaf** — the viewer refits within ~50–120 ms and anything typed before is repainted garbled (§4.2). Make `cols`/`rows` optional under `placement: "tile"` and let the first viewer's fit be the geometry.
10. `[improvement]` **`docs/PLUGINS.md` §Host services and the SDK: a page for the channel plane** — `SessionClient` construction with `host.token` + `sessionUrl()`, `openTerminal`/`attach`/`sendTerminalInput`, `useContainerRoute`, `usePolledResource`'s options object. The first table in §5 is the acceptance list.
11. `[improvement]` **"Registered in exactly two places" is five files plus an install** (§4.1): the two `package.json` dependency rows, `bun.lock`, and the hand-enumerated root `check` script. Either automate the dependency wiring or say so.
12. `[improvement]` **A later-installed seat is invisible to any principal who has arranged their workspace, with no in-product cue** (§4.1). A "new seats available" affordance in `core.arrange` or the plugin manager.
13. `[improvement]` **`vite.config.ts` proxies to a literal `:7777`**, so `dev:web` cannot follow `MANIFOLD_PORT` (§2); read the same env.
14. `[improvement]` **Placement refusal messages name the destination's kind, not the state** — `unknown_container: terminal -> composition` for a container that does not exist (§3.4). Cosmetic, but a client rendering the rule says "composition" about nothing.

Already filed and confirmed still binding for code (not restated as new): #151 / #152 loading,
#153 external binary (the roster carries no `code`/`omp` presence, §3.1), #154 capability names,
#155 companion seam, #157 machine node kind, #160 vocabulary sizing (this spike is one sizing
input: the launcher needed a labelled `select`, a `button`, a monospace preview and a status list;
`@manifold/plugin/ui` offered `Stack`, `Cluster`, `ScrollRegion`, `Chip`, `KeyValueList` — no form
control of any kind), #169 stream channel.

## 8. Files in `docs/spikes/code-launcher/`

| File                                  | What it is                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measure.ts`                          | The SDK harness for §3: roster, env/cwd, the race, the placement ladder, the workspace-tree refusals. `MANIFOLD_PORT=7799 bun docs/spikes/code-launcher/measure.ts` against a local hub. |
| `measurements.json`                   | Its last run, verbatim, including all 30 race trials.                                                                                                                                    |
| `shot-1-fresh-seat-canvas-routed.png` | The seat as a fresh principal gets it; "Launch here" disabled on a canvas.                                                                                                               |
| `shot-2-launch-here.png`              | One launch into the composition in view.                                                                                                                                                 |
| `shot-3-launch-new-composition.png`   | One launch through create + navigate.                                                                                                                                                    |
| `shot-4-terminals-above-launcher.png` | Two launched terminals above the dials — D4's picture, interim style, two trees.                                                                                                         |

The plugin itself is `packages/plugins/code-launcher-spike` in the spike commit and nowhere
else.
