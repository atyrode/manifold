# 0020 — The desktop shell: Electron as a host, the agent as the process it supervises

Date: 2026-09-01
Status: **ACCEPTED — ratified by the operator 2026-09-01, with one amendment: acceptance claim 5
(§6.3), the in-shell performance budget.** The ratification round weighed GPUI (§1.4a) at the
operator's ask before the yes. #82's own ruling still binds what a yes licenses: the ADR precedes
**any shell code** — nothing in this file licenses a directory, and §Deferrals is the list of
things this yes does **not** decide, each with the condition that reopens it.

## Context

There is no app shell in this tree. No Electron directory, no packaging target, no signing
pipeline, no sidecar wiring — and that is the correct state, because `AXIOMS.md` §Roadmap's App
shells bullet (`AXIOMS.md:286-296`) says the desktop shell is judged in its own dated ADR at its
milestone rather than sketched early. This file is that judgement, written against the tree as it
is on 2026-09-01 (`PROTOCOL_VERSION` 19, schema 14, `dev` at `c574fc2`).

Two things were already law before this file and are not reopened here:

- **The lens is never forked** (`AXIOMS.md` §The portable lens, `:422-438`). The web floor stays
  browser-pure — no Electron, Node, or otherwise host-specific import anywhere above
  `packages/web`'s entry — native capability arrives **only as host-composed plugins through the
  same manifests**, and absence of a capability looks exactly like any other disabled plugin
  (`REGISTRY.md` §Disable semantics).
- **Electron is the ratified leading candidate** for desktop; **Tauri is re-evaluated at a
  native-mobile milestone**, not at this one.

And two things the operator ruled on 2026-09-01, recorded in #82's comment and in `AXIOMS.md`
§Roadmap:

- **PWA-first.** The PWA pass (#109) lands first and this ADR depends on what it proves. Question
  26 is therefore answered before this file opens, and §5.6 records what the dependency actually
  costs in code rather than treating it as a scheduling note.
- **ADR before code**, which answers question 30 in the decide-then-build direction.

Two neighbouring records ratified the same day carry directly:
`docs/decisions/0019-identity-posture.md` (the owner key stays permanently as bootstrap and
break-glass; the NOW work is a principal/device list with revoke, #108) and ADR 0016, whose stage-3
rules — fail-closed verification, an artifact hash pinned and re-verified at load, registry review
documented as **not** a security control — are binding for plugin artifacts and are the rules §4
below has to answer to.

### What this file discovered that #82 could not know

Three findings from the tree changed answers rather than decorating them, and they are stated up
front because the rest of the document leans on them.

1. **There is no host-composition mechanism.** `WEB_PLUGIN_DEFS` in `packages/web/src/assembly.ts`
   is a static array literal, and `verify:axioms` S1 ("web assembly") parses that literal and
   requires every id in it to resolve to a roster entry
   (`scripts/verify-axioms.ts:545-570`). A plugin a host contributes at runtime is invisible to
   that check by construction. So "native capability arrives as a host-composed plugin" is a
   capability the floor **does not have yet**, and the shell's entire legitimacy under the
   portable-lens rule depends on it. §6.2 is the mechanism, and it is the largest thing in this
   file.
2. **The lens is still origin-bound.** `sessionUrl()` (`packages/plugin/src/session-url.ts`)
   derives the socket from `window.location`, and its own doc comment says so — it exists as a
   function precisely so that the one place changes when configurability arrives. The HTTP half is
   the same story a level down: `requestJson` calls `fetch(path, init)` with a relative path
   (`packages/web/src/api.ts:35-40`). "A configurable instance URL" is therefore work #109 owes,
   not a knob the shell can turn. §5.6 and §6.3 treat that as a hard prerequisite.
3. **The released agent asset is Linux-only.** `.github/workflows/release.yml:41` builds exactly
   `manifold-agent-linux-x64`. A macOS-arm64 shell that bundles an agent needs a
   `manifold-agent-darwin-arm64` asset that does not exist, produced by the one workflow allowed to
   publish. That is a named prerequisite with an owner (§5.4), not a build detail.

---

## 1. Runtime (questions 1–5)

### 1.1 Electron is confirmed, on the roadmap's stated grounds (Q1: **yes**)

Confirmed, and the grounds are the roadmap's own three, each checked against what this tree
actually does rather than restated:

- **Rendering predictability on the two hard surfaces.** The React Flow canvas and xterm are the
  two surfaces this repo has repeatedly had to patch at the renderer level — ADR 0003 patches
  xterm's pointer scaling, ADR 0007 rules on the React Flow renderer, invariant 9 exists because
  React Flow mutates nodes in place. Every one of those is a bug found against a _known_ engine.
  A bundled Chromium means the engine that ships is the engine those findings were made against.
- **`WebContentsView` embeds a real web view.** The alternative to embedding is re-implementing,
  and there is nothing in the lens whose rendering the shell wants to own.
- **The agent already fits the shape.** `packages/agent` is a standalone process configured
  entirely by environment (`MANIFOLD_SERVER_URL`, one of
  `MANIFOLD_MACHINE_TOKEN`/`MANIFOLD_MACHINE_TOKEN_FILE`, `MANIFOLD_MACHINE_NAME` defaulting to
  `hostname()` — `packages/agent/src/main.ts:24-33`, `machine-token.ts:1-11`) and shipped as one
  compiled binary. A host that can set three environment variables and supervise a child process
  can host it. Nothing has to be written to make the agent hostable; §2 is about who owns it, not
  about making it work.

The honest cost, stated because a verdict that lists only reasons to say yes is an advertisement:
Electron is the largest dependency this repo would take, it brings a second JavaScript runtime
into a tree whose runtime story is "Bun everywhere" (ADR 0001), and it makes this repo responsible
for a Chromium's security releases. §1.2 and §1.3 are those costs priced.

### 1.2 Electron is a runtime dependency of the product (Q2)

**Named answer: a runtime dependency of the product**, owing the full invariant-8 verdict, an
exact pin, and a stated update duty.

The ambiguity is real and it is worth closing loudly, because the classification decides whether
the largest dependency in the tree is governed by the only rule this repo has about dependencies.
A build/packaging target is something that runs to produce an artifact and is then **absent** while
the product executes: TypeScript, Vite, and the `bun build --compile` step are all that. Electron
is the process the product runs inside. Its Chromium serves the lens, its Node runs the shell's
main process, and a CVE in either is a CVE in something a user is executing. Calling that a build
target would be choosing the reading that exempts the biggest dependency from invariant 8, which is
exactly the "letting the ambiguity decide" #82 warned about.

One consequence follows immediately and is not a detail. Electron 44's main process is **Node
v24.18.1**, so `packages/desktop` would be the first Node-runtime package in a tree whose runtime
verdict is Bun 1.3.13 with "Node 24.15 as the documented fallback runtime for the agent package
only" (ADR 0001). This ADR does not reopen ADR 0001: the shell's main process runs on Electron's
bundled Node because that is what Electron is, the shared typegraph is unaffected (it is TypeScript
compiled by the workspace `tsc`), and — the load-bearing part — **the bundled agent stays the
Bun-compiled release binary**, spawned as a child, never re-hosted on Electron's Node. The agent's
PTY layer is `Bun.Terminal` (ADR 0001); running it on Node would require node-pty and a nix
toolchain ADR 0001 explicitly declined. So there is exactly one Node surface and it is the shell's
own main process.

### 1.3 The pin, the tracking policy, and who is on the hook (Q3)

**Pinned major: Electron 44, exact patch, in the style of ADR 0001's pins table.** Electron 44.0.0
went stable 2026-08-25 with Chromium **M152** and Node **v24.18.1**; its published end-of-life is
2027-03-02 (`releases.electronjs.org/schedule`, read 2026-09-01).

| Dep      | Pin                | Note                                                                                                                            |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| electron | 44.x exact         | current stable line; Chromium M152, Node v24.18.1; EOL 2027-03-02. Latest-major on purpose — see the duty below                 |
| (agent)  | the release binary | the shell bundles the published `manifold-agent-<platform>` asset at its own release tag; never a re-hosted script (§1.2, §2.4) |

**The tracking policy, as data rather than as intent.** Electron supports the latest three stable
majors, ships a new major every 8 weeks in concert with Chromium's 4-week cadence, and back-ports
security fixes only to the newest minor of each supported line. Three rules fall out and they are
the whole policy:

- **Patch duty.** A patch release of the pinned major that carries a Chromium security release is
  taken within one week of publication. Electron does not back-port to older minors, so "we are on
  44.0.3 and the fix is in 44.1.2" is not a state that can be waited out.
- **Major duty.** The pin never falls outside Electron's supported three. At an 8-week cadence that
  is a mandatory major bump at least every ~24 weeks, and no later than the pinned major's
  published EOL date. Pinning the _latest_ major rather than an older "settled" one is deliberate:
  the settled choice buys a few weeks of stability and spends the whole support window.
- **Latest-major, not latest-anything.** "Latest" stays a selection criterion and not a mandate,
  exactly as ADR 0001 put it. What is a mandate is _supported_.

**Who is on the hook: the operator**, and the reason to say so plainly is that a CVE duty assigned
to nobody is a CVE duty nobody discharges. Mechanically the pin is an exact version in
`packages/desktop/package.json`, so it is reviewable in a diff like any other pin; the candidate
machine for noticing is the same one that already watches this repo's releases — the dotfiles pin
refresh (atyrode/dotfiles#454) — and the coupling is stated here in #68's own words: **the guard
may be downstream, the coupling is this repo's to know.** This ADR does not promise downstream work;
it names where the notice would live and records that until it exists, the duty is a human's.

### 1.4 Tauri: defer to the mobile milestone (Q4: **defer-Tauri-to-the-mobile-milestone**)

Judged now, as #82 asked, and the answer is the roadmap's existing schedule — not out of deference
but because the question answers itself against this specific product. Tauri's advantages are
binary size and memory; its cost is a **system web view**: WebKitGTK on Linux, WebView2 on Windows,
WebKit on macOS. The two surfaces manifold is hardest on are precisely the two whose behaviour a
system web view makes a per-host variable. Trading a known engine for a smaller download is a bad
trade for a product whose renderer-level patch list (ADRs 0002, 0003, 0004) is evidence that the
engine matters.

At a native-mobile milestone the terms invert — a system web view is what mobile _is_, and binary
size stops being a rounding error — which is why the roadmap schedules the re-evaluation there.
**Revisit condition:** the native-mobile milestone opens, **or** the Electron duty in §1.3 is missed
twice, which would be evidence that this repo cannot carry a bundled Chromium and should stop
pretending otherwise.

### 1.4a GPUI: rejected as a category error, not on quality (operator ask, 2026-09-01)

Weighed at the operator's request during ratification, against the fear that Electron is
"notoriously bad in performances." GPUI (Zed's Apache-2.0 UI framework) is not a web-app host at
all — it is a **native Rust UI framework**. Adopting it would not port the client; it would mean
**writing a second client from scratch in another language** — every React component, the React
Flow canvas, xterm, and every plugin's web half reimplemented and maintained in parallel forever —
which is the one outcome the portable-lens rule forbids in as many words ("a fork of the client is
never the answer"). Zed could build on GPUI because Zed had no web client to keep; manifold does.

The performance reputation decomposes into two different facts: **memory** (a bundled Chromium's
RSS — real, recorded as the honest cost) and **slowness** (bloated JS shipped inside Electron by
apps that do not measure — not a property of the runtime). Rendering in Electron IS Chromium, the
engine both hard surfaces already target and the engine `verify:budgets` already ratchets on every
merge. That is why the ratification's amendment (§6.3 claim 5) answers the fear with measurement
inside the shell rather than with reputation in either direction.

### 1.5 Security posture, as data (Q5: **yes** — the preload exposes the manifests, nothing ambient)

| Setting                     | Value                    | Why it is not a default                                                                                                      |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `contextIsolation`          | `true`                   | the renderer runs the instance's own bundle, which is code this host did not build (§3.1); isolation is what makes that safe |
| `sandbox`                   | `true`                   | the renderer never needs a syscall of its own; every host capability is an IPC call validated in main                        |
| `nodeIntegration`           | `false`                  | a Node global in the renderer would make the portable-lens rule unenforceable rather than merely violated                    |
| `webSecurity`               | `true`                   | the lens is loaded over http(s) from the instance, so same-origin policy is the instance's, unmodified                       |
| `contextBridge` surface     | the registered manifests | see below                                                                                                                    |
| remote module, `webviewTag` | absent                   | no second embedding mechanism beside `WebContentsView` (invariant 14)                                                        |

**The preload bridge exposes exactly one thing, and its entire surface is the plugin manifests the
shell registers.** One frozen object in the main world with two members: the list of manifests the
host contributes, and one `invoke(pluginId, actionName, args)` channel. `invoke` is not a pipe: main
resolves `(pluginId, actionName)` against the manifests it registered, refuses anything not found
by name, and parses arguments with that action's declared schema before any host code runs. Nothing
ambient — no `fs`, no `shell.openExternal`, no `process`, no "just this one convenience".

This is the strict reading of the portable-lens rule and it is also the only reading that survives
its own consequences. An ambient preload API is a capability the lens could use without a manifest,
which means a capability that exists on one host and silently does not on another — the
conditionally-compiled surface §Disable semantics forbids, wearing a bridge's clothes. A
manifest-shaped surface is absent on the browser in exactly the way an absent plugin is absent,
which is the behaviour that is already specified.

---

## 2. The sidecar: the bundled agent (questions 6–11)

### 2.1 Bundle **and** discover, with a stated precedence (Q6, Q7)

**Both, and the precedence is discovery first.** Three rungs, resolved in order, and the rung the
shell took is part of the state a human sees (§2.3):

1. **Configured.** An explicit setting saying this host's agent is somebody else's — the
   service-managed fleet case (#7: the server and the agents on this box are NixOS units, and a
   shell that spawned its own would be the second owner of one process). The shell attaches to
   nothing and spawns nothing; the workspace's machine row is the service's.
2. **Discovered live.** No configuration, but the workspace already reports an agent online for
   this host's machine name. The shell **attaches** — meaning it spawns nothing and treats the
   existing agent as the machine — and never rotates its credential.
3. **Bundled.** Neither of the above: the shell spawns the agent binary it ships, as a child
   process it supervises, and kills it with the window (§2.3).

**Discovery has exactly one source of truth, and it is the hub.** `core.machines.list` publishes
every machine row _with live connectedness_, and only the machine gateway knows the second half
(`packages/server/src/main.ts:102-106`, `plugin-host.ts:276-279`). A shell that probed a local
socket or a PID file would be inventing a second answer to "is an agent running here" — invariant
14 — and it would be the _wrong_ answer, because what matters is not whether a process exists on
this box but whether the workspace has it. So the shell asks the door that already knows.

The rejected alternative is "spawn unconditionally, let the hub dedupe". It is rejected because the
hub's dedupe is not built for this: two processes holding one machine token are two writers on one
credential, and the tidy-up path #48 landed (migration 4 renames name-colliding machine rows
`name || '#' || id`, revokes the losers' tokens, keeps every session) is for two _hosts_ that share
a name, not for two shells on one host. Using it as a spawn guard would be borrowing a repair for a
mistake as a licence to make it.

### 2.2 Enrolment, and the second install on one host (Q9)

**The shell enrols at rung 3 only, main-side, and one host is one machine per OS user.**

Enrolment is `core.machines.enroll` (`caps: ["machines:mint"]`, and `enrollMachine` additionally
refuses any container-scoped caller — `auth.ts:626-631`), called from the shell's **main** process
with the owner key held for the length of the call and never afterwards (§3.2). It is idempotent by
name: a re-enrol returns the same machine row and **no token**, and `rotateToken: true` re-mints
while revoking the previous secret (`auth.ts:644-654`,
`packages/server/test/machines-actions.test.ts:127-164`).

That idempotency decides the second-install question completely, and the answer is _not_ "a new
machine row":

- The machine name is the agent's existing default — `hostname()` — and the shell does not invent a
  second derivation of it.
- The machine token is persisted main-side (§3.3), scoped to the OS user's application data. A
  second install for the **same OS user** finds that file and never enrols at all.
- A **second OS user** on the same host is a second machine, named `<hostname>/<user>`, because it
  is a different credential custodian and pretending otherwise would put two users on one token.
- A shell that finds a machine row for its name but holds **no** token file **refuses and says so**
  — a named state, not a silent `rotateToken: true`. Rotating would revoke the token a running
  agent holds, which is the exact mistake the test at `machines-actions.test.ts:127-141` was written
  to prevent, in its own words: _a re-run provision flow must never invalidate the token a running
  agent holds (#40)_. Rotation stays a deliberate act a human asks for.

### 2.3 Crash policy: ADR 0016 §6's shape, and health is a state (Q8)

**Copied verbatim in shape from ADR 0016 §6, which took it from VS Code as data: a bounded number
of restarts in a bounded window, then stop and say so.** Three restarts in five minutes
(`abstractExtensionService.ts:1565-1588`, cited in ADR 0016 §6 at `:73-75` and `:269-271`), then
the shell stops restarting and reports it.

**The sidecar's health is an observable state, not a log line**, and it has a closed set of values
the shell surface names: `configured` (rung 1 — not ours), `attached` (rung 2), `running`,
`restarting (n/3)`, `failed (restart budget exhausted)`, `refused (protocol)` (§2.5), `refused
(already enrolled, no credential)` (§2.2). The reason this list is written down rather than left to
implementation is A6's own reasoning at one remove: a state a human can be shown is a state a human
can act on, and ADR 0016's finding was that a crashed isolate must be _a degraded roster row every
principal sees, not a log line somebody greps_. The natural home for the row is the shell's own
host-composed plugin (§6.2); before that mechanism exists there is no legal place to paint it,
which is one more reason §6.2 is a prerequisite rather than a flourish.

### 2.4 Update: one artifact, one version (Q10: **with the shell**)

**The sidecar updates with the shell.** The shell bundles the agent binary published for its own
release tag, and there is no second channel.

The argument is #68's, and it is not an aesthetic preference. `MACHINE_PROTOCOL_COMPAT_VERSIONS`
(`packages/protocol/src/version.ts:164`, currently `{16, 17, 18, 19}`) makes a hub tolerant of
agents **older** than itself and nothing makes it tolerant of newer: a hub cannot accept a version
that did not exist when it was built, so every dial closes `4409` forever. An independently
updating sidecar makes that direction _routine_ rather than exceptional — a spoke that updates on
its own schedule against a hub that updates on the operator's is the v0.5.0 incident as a standing
condition. One artifact means the shell's agent version is a fact about the shell's version, which
is the only pairing this repo's release discipline can reason about.

**Deferral D6, named with its condition:** an independent sidecar channel is reopened when the
agent-newer-than-hub direction is guarded **in this repo** rather than only downstream — that is,
when #68's declined third criterion (a release-time assertion against a configured hub's
`/healthz`) or an equivalent handshake guard exists. Until then, two channels is two ways to
reproduce a known outage.

### 2.5 Protocol disagreement: a named refusal, before the spawn (Q11)

**A named refusal the human sees, and — the part worth the ink — it is raised _before_ the doomed
process starts.**

The mechanism needs nothing new. `GET /healthz` is unauthenticated and publishes
`protocolVersion` (`packages/server/src/http.ts:131-139`,
`HealthResponseSchema`), which is already how the downstream pin refresh compares a candidate
release against a deployed hub (#68). So at rung 3 the shell reads `/healthz` first and, if its
bundled agent's `PROTOCOL_VERSION` is outside what that hub can accept, it does not spawn: state
`refused (protocol)`, with both numbers in the message.

This is the first place in the system where that failure is visible at all, and that is the
strongest single argument for a supervising shell. `docs/CONTRACTS.md` §machine channel records
(via #68) that the unknown-newer direction is **permanent and silent from the agent's side**: the
agent re-dials with jittered backoff indefinitely rather than exiting, systemd keeps reporting
`active (running)`, and unit state is not evidence the agent is on the canvas. A shell that
supervises its own child can see the `4409` close code and can therefore turn a permanent silent
lockout into a sentence. A shell that spawned blindly would merely add a GUI to the silence.

---

## 3. Auth bootstrap on first run (questions 12–16)

### 3.1 Where the lens comes from, because it decides the rest

Before the credential question there is a prior one #82 leaves implicit, and answering it collapses
half of §3 and all of §4's compatibility matrix: **does the shell load the instance's served bundle,
or a copy of `packages/web` it ships?**

**It loads the instance's own bundle.** The `WebContentsView` navigates to the configured instance
URL and gets whatever that instance serves, exactly as a browser does.

- The lens version then always matches the server, so there is no shell-lens skew and no compat
  matrix to maintain (§4.4).
- "The web floor stayed browser-pure" becomes structurally true rather than checked-and-hoped: the
  shell cannot import into a bundle it does not build.
- There is no second copy of the lens to keep in sync. A bundled copy is a fork by staleness — the
  slowest possible way to violate "a fork of the client is never the answer".

The costs are real and both are named as deferrals rather than hidden: the shell paints nothing
without a reachable instance (**D8**, offline — owned by #109's offline-shell work, inherited
whatever it proves), and host-composed plugins must be injected at runtime into a page the shell did
not build, which is precisely why §6.2 exists.

### 3.2 Minted token, and the root secret never reaches the renderer (Q12: **minted-token**)

**Minted-token.** And the sharper claim, which is the reason it is better rather than merely
newer: **there is no root secret at rest anywhere in the shell.**

The flow, three steps, all in main:

1. The human pastes the owner key once, into the shell's own first-run field. It is held in main's
   memory.
2. Main mints a per-principal token through the ordinary door (§3.3) and — at rung 3 only — enrols
   the machine (§2.2).
3. Main **drops the owner key**. It is not written to a keychain, not to `safeStorage`, not to a
   0600 file. Break-glass is paste it again, which is the same act the browser performs when a
   `#key=` fragment is opened again, and which ADR 0019 §1 keeps permanently available by design.

Compare the two candidates as #82 framed them. **Owner-key parity** would mean a 64-hex root secret
(`secretsEqual` over `timingSafeEqual` buffers, `auth.ts:96-101`; the owner path in `authenticate`
returns `caps: ["*"], containerScope: null, isRoot: true`) at rest in an OS store, invisible to the
workspace, revocable only by rotating the file for every browser at once. **Minted-token** puts a
named, capability-limited, individually revocable principal in the workspace instead. ADR 0019 did
not decide this, and it said so; what it did was make both expressible and price them — and #108's
principal/device list with revoke is what turns "a desktop is a principal" from a claim into
something a human can see and sever.

### 3.3 Which door, which caps, and where the bytes live (Q13, Q14)

**The door is `core.access.mint`.** Not `core.access.createPrincipal`, and the distinction is not
pedantry: `createPrincipal` is the browser's own bootstrap and it mints `caps: ["*"]` — a
root-equivalent bearer token (`bootstrapPrincipal`, `auth.ts:538-543`; the door declares
`caps: ["*"]` precisely so a reader can see it is root-only,
`packages/plugins/access/src/index.ts:137-143`). Handing the renderer _that_ would be replacing a
root secret with a root token and calling it attenuation. `core.access.mint` declares
`caps: ["tokens:mint"]`, creates its principal inline from the request's `principal` field, refuses
`*` to any non-root minter, and attenuates against the minter's own authority
(`auth.ts:547-560`, `access/src/index.ts:144-160`).

**The caps a desktop lens's principal gets:**

```
containers:read, scenes:write, terminals:spawn, terminals:write
```

That is not a fresh invention — it is the exact set the server already mints for a share-admitted
principal (`auth.ts:606`), which is the closest existing answer to "a lens that reads the workspace
and works in it". What is deliberately **absent** matters more: no `tokens:mint` (a lens that can
delegate is a lens that can escalate sideways, and a desktop has nobody to delegate to), no
`machines:mint` (enrolment happens in main, which holds root for the length of one call — the
renderer never needs it), no `plugins:manage`, no `*`.

**Revocable like any other principal: yes.** `core.access.revoke` (`caps: ["tokens:mint"]`,
`cleanup: true`) severs it, and live sockets die on the revocation fence
(`AuthService.onRevoked`, `auth.ts:1045`). It appears in #108's list because it is an ordinary
principal; the shell asks for nothing special to be visible.

**Where the credential lives — one implementation, not three:**

| Credential                 | Where                                                                                           | Why that and not a keychain                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the lens's bearer token    | the renderer partition's own `localStorage`, key `manifold.identity`                            | the lens writes it, because the lens is the instance's unmodified code (§3.1). Zero shell code, zero platform branches, and the key is already in `REGISTRY.md` §Device-local register |
| the machine token (rung 3) | a 0600 file under Electron's `app.getPath("userData")`, passed as `MANIFOLD_MACHINE_TOKEN_FILE` | reuses the agent's existing one-of-two token contract (`machine-token.ts:1-11`) rather than inventing a third source                                                                   |
| the owner key              | **nowhere** — memory, for the length of the mint (§3.2)                                         | a secret that is never persisted needs no vault, and this is the only answer that makes "the root secret never reaches the renderer" also mean "never reaches the disk"                |

**Q14's "is it a per-platform answer with three implementations or one": one.** A file mode and a
browser partition are the same code on macOS, Linux and Windows.

**Deferral D5, named with its condition:** OS keychain / Electron `safeStorage` is deferred behind
its own invariant-8 verdict (§7's table). It is reopened when the shell must hold a credential it
**cannot re-derive from a one-time paste** — the first such case is a rung-3 shell whose machine
token must survive a userData wipe, or any shipped artifact where a 0600 file is judged too weak
for the machine token's blast radius — or at the first signed public artifact, whichever comes
first. Recorded honestly: a 0600 file is readable by anything running as that user, and the reason
that is acceptable _now_ is that the prototype is dev-only and the machine token is a credential
that same user can already re-mint.

### 3.4 The shell is a forcing function for #58, deliberately upstream (Q15)

**A forcing function, not a consumer**, and #82's framing survives intact.

The shell is the first host where "whoever holds the URL is root" stops being an accurate
description of the threat model, because there is no URL to hold: the credential is a file and a
partition on somebody's laptop. It does not wait for #108 — §3.2's posture is expressible against
the doors that exist today, which is what ADR 0019's "an identity layer is additive" finding
predicted. What it does is **consume #108 the day it lands** (its principal is in the list and
severable from it) and **add one requirement the browser never generated**: a principal whose name
says which host it is, because a device list whose rows read "desktop" three times answers nothing.
That requirement is this ADR's contribution to #58 and it is stated here so #108 can absorb it
rather than discover it.

### 3.5 Multi-instance: one instance per window (Q16)

**One instance per window, and the credential is scoped to the instance.**

This needs no new mechanism, which is the argument for it: the lens derives its instance from the
page origin, so _selecting_ an instance is navigating a window, and one-per-window is what the
architecture already is. The credential's key is the normalized instance origin —
`normalizeInstanceOrigin`, the function `auth.ts` already imports and ADR 0014 already keys shares
by, the same `(origin, containerId)` keying `AXIOMS.md:198-199` records as the reason pointing a
lens at a second instance needed no new client. Two windows on two instances are two credentials,
both scoped, neither ambient to "the shell".

**Deferral D7:** an instance **picker** and per-instance **profiles** are out. Reopened when one
principal routinely works two instances from one desktop — and the earlier signal for that is
ADR 0014's dial path getting used in anger, not a shell feature request.

---

## 4. Update channel (questions 17–20)

### 4.1 Operator-updated first (Q17: **operator**, with auto deferred behind its own verdict)

**Operator-updated.** A downloaded artifact, a package manager, `atyrode apply` on the managed
fleet — the release story this repo already has (#7, #68). Auto-update is **deferred, behind its own
invariant-8 verdict**, and is not a thing a yes to this ADR authorizes.

The reasoning is that auto-update's cost is not the dependency, it is the _server_. An updater
needs an update endpoint, a signing story that is already working, and a fail-closed verification
posture — none of which exist. Shipping an updater before an artifact is signed would be shipping
the mechanism that fetches and executes code, in the window where nothing can verify it.

**Deferral D2, named with its condition:** reopened when both hold — a signed artifact exists
(§5.3), **and** somebody installs it who is not on `atyrode apply`. The first non-operator installer
is the exact moment "the operator updates it" stops being a policy and becomes a fiction.

### 4.2 If and when auto-update lands, ADR 0016 R8's three rules apply verbatim (Q18)

ADR 0016 was ratified as written on 2026-09-01, so its stage-3 rules are binding for plugin
artifacts and #82 asks whether the shell's updater inherits them or writes down the difference.
**It inherits them, unchanged, and there is no difference to write down:**

- **Verification is fail-closed.** VS Code's fail-open path is the bug ADR 0016 declined to copy,
  and an updater is a strictly worse place to fail open than a plugin loader.
- **The artifact hash is pinned and re-verified at load.** Obsidian's model — review a repository
  once, then fetch whatever the developer released — is the supply-chain hole ADR 0016 named. An
  update feed is that model by default.
- **Registry review is not a security control**, which for an updater reads: hosting the feed
  ourselves is not verification.

The update **server** is therefore not chosen here, because choosing it is part of D2's verdict. What
is decided now is the constraint any choice must satisfy: the three rules above, and no second
release vocabulary (§4.3).

### 4.3 The existing channels, and no second vocabulary (Q19)

**The shell shares the existing dev/stable release channels.** #68's rule is that publishing is a
fleet action and a version names a frozen released artifact; a shell with its own channel names
would mean two answers to "what version am I running" on one machine, which is the same failure as
two owners of one process one layer up. The shell's version **is** the repo's release tag — which is
also what makes §2.4's one-artifact rule expressible at all.

### 4.4 Compatibility between a shell version and a server version (Q20)

§3.1 dissolves most of this question, and the residue has one answer each:

- **Shell lens vs server: no skew exists.** The renderer loads the instance's own bundle, so the
  lens is always the server's own. There is nothing to negotiate and no matrix to publish. This is
  the single largest reason §3.1 went the way it did.
- **Bundled agent vs server: refuse, visibly, before spawning.** §2.5. An old shell against a newer
  hub is the survivable direction (the compat set exists for it); a shell whose bundled agent is
  _newer_ than the hub is the unguarded direction, and the shell's answer is a named refusal rather
  than a silent `4409` loop.
- **Shell chrome vs server: nothing to break.** The shell's own surface is a window, a sidecar and
  one host plugin. It holds no protocol state of its own beyond the host-manifest join field §6.2
  introduces — which is additive-optional, so an old shell against a new server and a new shell
  against an old server both degrade to "no host plugin", which is ordinary absence.
- **Does an old shell update itself first?** No: there is no auto-update (§4.1). It refuses the part
  it cannot do and says which part.

---

## 5. Packaging and signing (questions 21–26)

### 5.1 The first shipped target set (Q21)

**macOS arm64, and Linux x64.** Named, and everything else named as out with its condition, because
"all of them" is how a signing bill becomes a surprise.

| Target        | In the first set? | Note                                                                                                                         |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64   | **yes**           | the operator's own machine class, and the platform whose signing and hardened-runtime rules bind hardest                     |
| Linux x64     | **yes**           | the fleet is NixOS; this is where `atyrode apply` already reaches                                                            |
| macOS x64     | no — **D3**       | reopened when an Intel Mac needs it; a second arch on an already-signed pipeline is cheap, so this is scheduling, not policy |
| Windows x64   | no — **D3**       | reopened when a Windows host needs the lens; §5.3 states the bill now so it is not a surprise then                           |
| Windows arm64 | no — **D3**       | as above                                                                                                                     |

**Linux form:** a Nix flake output for the managed fleet, because `atyrode apply` is the existing
verb and a second Linux packaging format would be a second answer to "how is this installed" on the
one platform where the answer is already settled; plus a plain tarball for a non-Nix Linux user.
AppImage and `.deb` are **out (D3)**, reopened when a non-Nix, non-operator Linux user exists.

### 5.2 macOS: signed and notarized, and the bill (Q22)

**Notarized**, for the shipped artifact — and the prototype is explicitly unsigned (§6.4), which
means this section is a bill and a risk register rather than a description of something done.

The bill, itemised:

- **Apple Developer Program: $99/year** (organizations via the Enterprise Program: $299/year).
  Notarization itself carries no additional fee, and neither does creating or using the signing
  certificates.
- **A Developer ID Application certificate**, whose private key becomes a new high-value credential
  (§5.4).
- **`codesign` + `notarytool` steps** in the one workflow allowed to publish (§5.4), plus stapling.
- **Hardened runtime**, with entitlements decided rather than accreted:
  - `com.apple.security.cs.allow-jit` — required; it is what a JavaScript engine is.
  - `com.apple.security.cs.disable-library-validation` — **rejected**, unless the bundled
    Bun-compiled agent provably cannot be signed without it. It is the standard one-line "fix" for
    a sidecar that will not launch, and it trades the guarantee for the convenience. If the
    measurement says it is unavoidable, that finding goes in this file as an amendment with the
    measurement attached, not into a build script as a flag.
- **The sidecar carries its own signature.** #82 is right that this is the case that breaks unsigned
  sidecars: a hardened-runtime parent spawning an unsigned child is exactly what gets refused. The
  bundled agent is signed with the same Team ID as the app, as a separate signed executable inside
  the bundle.

**The stated risk, because §6.4 excludes signing:** the prototype will therefore **not** prove that
the hardened runtime tolerates a spawned Bun-compiled agent. That is knowingly untested, it is the
**first** thing the first signed artifact must prove, and it is the most likely source of an
unpleasant surprise in this whole document. It is written here rather than discovered later.

### 5.3 Windows: the route, the cost, and who holds the key (Q23)

Windows is out of the first set (§5.1), and the route is named now so that the deferral is priced
rather than blank.

**Route when it lands: Azure Artifact Signing** (formerly Trusted Signing) — **$9.99/month for up
to 5,000 signatures** with one certificate profile, $99.99/month for the 100,000-signature tier,
$0.005 per signature beyond quota; generally available in the USA, Canada and Europe since January 2026. The decisive property is not the price, it is **key custody**: the signing key is held by the
service, not by this repo. The identity-validation step is the real cost in time.

**OV/EV code-signing certificates: rejected on custody grounds.** An EV certificate lives on
hardware, and hardware in a CI runner is a key this repo's release story has nowhere to put. An OV
certificate is a private key in a secret store, which is the same problem with a smaller sticker
price.

**Unsigned, stated plainly** as the only honest interim if a Windows build ever ships before the
above: SmartScreen will warn on every download until reputation accrues, and reputation accrues per
signing identity — so an unsigned Windows build does not build reputation toward a later signed one.
"Users can click through" is a consequence, not a mitigation.

### 5.4 Secrets, and who can run a release (Q24)

**The signing identities live as secrets on the one workflow allowed to publish**
(`.github/workflows/release.yml`), and **only the operator runs a release.**

Three rules, and each has a reason drawn from something already in the repo:

- **One publishing path.** The shell's signing and packaging steps go into the existing release
  workflow, not a second one. Two publishing paths is two answers to "how does an artifact become
  real" (invariant 14), and #68 already established that publishing is a fleet action rather than a
  build.
- **No agent runs it.** The declination recorded in #68's comment — that modifying the one path
  allowed to commit to `main` and publish binaries the fleet consumes within hours is outside an
  agent's conservative bounds — applies at least as strongly to a path that also holds a code-signing
  identity.
- **The blast radius is stated.** A signing identity in CI signs artifacts a fleet consumes. It is
  a strictly higher-value credential than anything currently in this repo's secrets, and adding it
  is the reason §5.2 and §5.3 are a bill rather than a checkbox.

### 5.5 Built in this repo, and the registry edits that ride the change (Q25)

**In this repo**, as a new workspace package. A separate repo would mean a second release
vocabulary (§4.3 forbids it), a second version of the protocol types instead of the one shared
typegraph ADR 0001 exists to protect, and a cross-repo bump for every wire change.

**The package is `packages/desktop`, and it is deliberately not called `shell`.** The word `shell`
is taken: `core.shell` is the workspace-chrome plugin and `packages/plugins/shell` is its package.
Using it for the Electron host would be two concepts for one word — the thing invariant 16 and
`AXIOMS.md` §Lexicon law forbid, checked mechanically by S11 on file and directory names among other
subjects. So the host takes its own word, `desktop`, and the change that creates the package owes a
lexicon row for it (`means`: the Electron host that composes the lens on a desktop OS; `banned`:
`app-shell`, `electron-app`, `wrapper`).

**And the tree gains no new word for the agent-as-child.** "Sidecar" is #82's vocabulary for a
lifecycle relationship and it is a good word for an issue; in the tree the process is an **agent**
and its row is a **machine**, both existing terms with existing meanings. Inventing `sidecar` as a
third name for one of them would be the lexicon violation this ADR just declined to make with
`shell`.

**Which registry rows this obliges, stated precisely so the implementing change does not guess:**

- **A `REGISTRY.md` §Decisions awaiting ratification row for this ADR — now, in this commit**, per
  #82's third acceptance criterion.
- **No pillar row, and that is the finding rather than an omission.** `packages/desktop` is a
  **host**, and a host is neither floor nor plugin: it fails the floor litmus on its face (nothing
  in the tree presupposes it; it is not neutral over hosts, it _is_ one), and it contributes no
  manifest to the server assembly. `packages/testkit` is the standing precedent for a package that
  is neither, so nothing about S5, S6 or S9 changes. What the implementing change owes is one
  sentence of §Pillar inventory prose saying so, because the next reader will otherwise go looking
  for the row.
- **A lexicon row for `desktop`** (above).
- **A gate-contract row for the browser-purity check** (§6.5), since that check is a new mechanical
  claim and `REGISTRY.md` §Gate contracts is where mechanical claims are declared.

### 5.6 PWA-first, already ruled — and what the dependency actually is (Q26: **PWA-first**)

Ruled by the operator on 2026-09-01 and recorded in `AXIOMS.md` §Roadmap: the PWA pass (#109) lands
first and this ADR depends on what it proves. What #82 could not know, and what turns that from a
scheduling note into a hard prerequisite, is **how much of the shell's premise #109 owns in code**:

- **Origin configurability.** `sessionUrl()` (`packages/plugin/src/session-url.ts:12-15`) derives
  the socket from `window.location` and says in its own comment that it is the one place that
  changes when the instance becomes configurable. The HTTP half is `requestJson`'s relative
  `fetch(path, init)` (`packages/web/src/api.ts:35-40`). Both are #109's work under the
  portable-lens rule, and **"a configurable instance URL" in the prototype's scope is exactly those
  two seams**. Until they move, a desktop shell can only point at whatever origin serves it, which
  is not a lens.
- **The offline shell.** §3.1 makes the shell paint nothing without a reachable instance. Whatever
  #109's offline shell proves is what the desktop inherits; the desktop invents no second answer.
- **Installability** is #109's alone and the desktop takes nothing from it.

So the dependency is not "wait politely". It is: **two named seams and an offline story**, and the
prototype's first acceptance claim is unmeetable before them (§6.3).

---

## 6. The smallest testable prototype (questions 27–30)

### 6.1 The scope is confirmed, with two amendments (Q28: **yes, amended**)

#82's candidate scope is the right prototype and it is confirmed:

> one window, one `WebContentsView` loading the existing `packages/web` bundle unmodified against a
> configurable instance URL, one spawned sidecar, one host-composed plugin contributed by the shell
> (the smallest real native capability — OS notification or tray), no auto-update, no signing,
> dev-only.

Two amendments, both consequences of findings rather than additions of appetite:

- **"Loading the existing bundle unmodified" is sharpened to "loading the instance's served
  bundle"** (§3.1). "Unmodified" and "the copy we ship" cannot both be true for long.
- **The native capability is the OS notification, not the tray.** A notification is a one-shot,
  observable, permission-shaped act that maps onto an action in a manifest; a tray is a persistent
  surface with its own lifecycle and its own place in the chrome, which makes it the second-simplest
  thing available. Pick the first.

And the capability is chosen with `AXIOMS.md` §Roadmap's Notifications bullet in view: the durable,
addressed notification is wave-2 event-plane work and is **not** what this is. The host plugin
raises an **OS-level** notification for something already local to this device. It must not become
a second implementation of the notice layer or a down-payment on durable notifications, and the
manifest's one action says which of the two it is.

### 6.2 The one new mechanism: host-composed plugins need a registry, so they need a join field

This is the largest thing in this file and it is the prototype's prerequisite.

**The problem, mechanically.** `WEB_PLUGIN_DEFS` is a static array literal parsed by
`verify:axioms` S1, which requires every id in it to resolve to a roster entry
(`scripts/verify-axioms.ts:545-570`). The roster is the server's assembly. So a host plugin has
nowhere to be: adding it to `assembly.ts` from the shell is impossible (the shell does not build
that bundle) and would be forking the lens if it were; injecting it into the renderer without a
roster row makes it a plugin nobody can disable, nobody can see in the Plugins section, and for whom
§Disable semantics has nothing to say — a conditionally compiled surface wearing a manifest.

**The two candidate shapes, and the verdict.**

- **Client-only registration.** The preload hands the lens's plugin host a manifest and its
  components; the server never hears of it. Cheapest, and **rejected**: `plugins:manage` cannot
  reach it, D4′ has no row for it, and "absence looks exactly like any other disabled plugin" becomes
  false for the one plugin class the roadmap says native capability must arrive as.
- **A declared host plugin, admitted at join.** The session join carries the host's manifests in one
  **additive-optional** field; the engine admits them as roster rows with `source: "host"` — a third
  source beside `builtin` and whatever the distribution wave adds — and publishes them like any
  other. A browser sends the field absent, which reproduces today's behaviour exactly and makes a
  host plugin **absent** in a browser in the ordinary way. **Adopted.**

**Why the second shape is the only one that satisfies a law rather than a preference.** `AXIOMS.md`
§"Every runtime-joined namespace has a registry (the LAW)" (`:387-408`) says a namespace whose two
halves are joined at runtime by matching strings gets a registry and a gate check, or it rots
invisibly. A host contributing a plugin id that the renderer looks up is precisely that join. The
registry is the roster the engine publishes; the check is that every host-registered id resolves in
it and every registered manifest's contributions attach (the S1 pair, extended rather than
duplicated).

**The protocol cost, stated as a cost.** One optional field on the session join, shipped as a
dedicated `protocol:` commit per invariant 10, with `PROTOCOL_VERSION` bumped by that change and by
nothing else in the prototype. Absent field = pre-bump semantics exactly, which is what makes it
additive-optional rather than a wire break. This is the one place the prototype touches the wire,
and it is named here so the ADR's yes covers it rather than the implementation discovering it needs
permission.

### 6.3 The four acceptance claims, confirmed — and what each actually requires (Q27)

Confirmed as written, with the mechanism each one needs spelled out, because an acceptance claim
without a mechanism is an aspiration:

1. **The web floor stayed browser-pure — zero Electron/Node imports above `packages/web`'s entry,
   mechanically checked.** No such check exists today (§6.5 is the check). It is a gate condition
   and not an aspiration because the portable-lens rule says so, and because this is the first
   change in the repo's history that makes violating it _convenient_.
2. **The two hard surfaces render correctly — the React Flow canvas and xterm.** This is the entire
   stated reason Electron is the candidate, so it is the claim that would falsify the runtime
   verdict rather than merely fail the prototype. Verified the way this repo verifies rendering:
   against the running surface, at the interaction boundary (invariant 9's last clause: wire-level
   green is not evidence the UI layer works).
3. **The native capability arrived as a plugin through the same manifest, and the browser host sees
   it as an ordinary absent plugin.** Requires §6.2. Without the join field this claim is decorative
   — the honest reason §6.2 is in scope.
4. **The sidecar's lifecycle is observable: it starts, it is enrolled, it is killed with the window,
   and its failure is a state a human sees.** Requires §2.3's state list and §2.5's pre-spawn
   refusal. "Killed with the window" is the part with a real failure mode: the box has been OOM'd by
   orphaned processes before, so the teardown path is the one that gets tested deliberately rather
   than assumed.
5. **The performance budgets hold inside the shell** (the ratification's amendment, 2026-09-01):
   `verify:budgets` runs against the app hosted in the shell's own window and every ceiling that
   holds in the browser baseline holds there — idle re-renders, idle script time, long tasks,
   request counts. The operator's stated fear about Electron is its reputation for slowness; this
   claim converts the fear into a measurement. A miss does not merely fail the prototype: it
   **triggers D1's Tauri re-evaluation early**, without waiting for the mobile milestone or the
   twice-missed pin duty. Memory footprint is recorded alongside the run as the honest cost that
   no budget currently bounds.

**And one prerequisite that is not a claim but a gate on claim 1's premise:** "against a configurable
instance URL" requires #109's two seams (§5.6). Before they land the prototype can only load its
serving origin, which does not exercise the property the prototype exists to prove.

### 6.4 What is explicitly out (Q29: **confirmed, and amended by addition**)

#82's exclusion list is **confirmed** in full: signing, notarization, auto-update, Windows,
multi-instance profiles, keychain storage. Amended by **adding** six, each because it is a thing a
reasonable person would otherwise slide in:

- **A bundled copy of the web dist.** The shell loads the instance's bundle (§3.1). A local copy is
  a fork by staleness.
- **A second agent update channel** (§2.4).
- **Offline behaviour.** #109's, inherited, not invented here (D8).
- **Any surface beyond the one host plugin** — no tray, no menu-bar item, no global shortcut, no
  deep-link handler.
- **Any edit to `packages/web/src` other than the host-composition seam**, and that seam names no
  host and imports nothing host-specific: it reads host contributions from a neutral injected
  global, which in a browser is absent, so its browser behaviour is "no plugins added" — ordinary
  absence, not a branch.
- **Any wire change other than §6.2's one additive-optional join field.**

### 6.5 The browser-purity check, since claim 1 says "mechanically"

Claim 1 says mechanically and no mechanism exists, so the prototype's change carries one: a
`verify:axioms` check that walks imports reachable from `packages/web`'s entry and fails RED on any
Electron or Node specifier — `electron`, `node:*`, and the bare builtins — plus any import of
`packages/desktop`. It is declared in `REGISTRY.md` §Gate contracts like every other mechanical
claim (§5.5).

Two properties are deliberate. It is an **import walk, not a token grep**, because ownership is a
graph property — the same reasoning `REGISTRY.md` §Lexicon gives for why S2 must parse and follow
edges while a vocabulary check may read tokens. And it has **no exemption list**, because the rule
it encodes has no exceptions: `AXIOMS.md` §The portable lens says "anywhere above `packages/web`'s
entry", and a check taught to tolerate one import is a check that has stopped being the rule.

### 6.6 ADR before the prototype (Q30: **decide, then build**)

Already ruled by the operator and binding: the ADR is authored and ratified before any shell code
exists. #82's own framing — "this issue is the gate, not the build" — is confirmed as binding.

The precedent question is worth answering precisely, because ADR 0016 measured first and ADR 0001's
evidence section is nothing but measurement. The reconciliation is that **measurement is allowed and
a shell is not**. Any measurement that informs this ADR is a **throwaway spike**: it lives in
`docs/spikes/` (where ADR 0001's `s2-pty.ts` and `s2-pty-backpressure.ts` still sit), no package
imports it, its numbers go into the record with the same refusal ADR 0016 attached to its own — they
are findings from a throwaway harness and nobody may quote them as benchmarks — and it never
becomes the shell by accident. A spike that acquires a `package.json` under `packages/` has stopped
being a spike.

**No spike was needed for this file.** Every number in it is either published upstream data
(Electron's schedule, Apple's and Microsoft's prices) or a fact read out of this tree, each cited at
its use.

---

## 7. Invariant-8 verdicts: one per dependency

Invariant 8 applies per dependency, and `AXIOMS.md` §Change control's converse applies too: a
pattern that is not manifold-specific gets a named library evaluation — candidates, code and
maintenance saved, opinionation cost — recorded in the owning ADR before it is hand-rolled. #82 is
right that this is four verdicts, not one. Two are taken now; two are deferred, each behind its own
verdict and its own revisit condition, which is what makes them deferrals rather than silence.

| Dependency                   | Verdict                                 | boring / small / pinned                                                                                                                                                                                                       | Saved vs. opinionation cost                                                                                                                                                               |
| ---------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron 44**              | **TAKEN** (§1.1–1.3)                    | boring: 13 years old, OpenJS Foundation, the most-deployed desktop web host there is. small: **no** — it is the largest dependency in the tree, and that is the price of the verdict. pinned: exact patch, with the §1.3 duty | Saves: a browser engine, an embedding layer, a process model, an OS integration layer. Opinionation: a main/renderer split and a Node runtime the rest of the tree does not use (§1.2)    |
| **Packaging toolchain**      | **PROPOSED**, due at the first artifact | candidates below                                                                                                                                                                                                              | The prototype needs **none** — `electron .` runs it, and that is why the verdict is due later rather than guessed now                                                                     |
| **Auto-updater**             | **DEFERRED — D2** (§4.1)                | —                                                                                                                                                                                                                             | Reopened when a signed artifact exists **and** a non-operator installs it. Whatever is chosen inherits ADR 0016 R8's three rules verbatim (§4.2)                                          |
| **Keychain / `safeStorage`** | **DEFERRED — D5** (§3.3)                | —                                                                                                                                                                                                                             | Reopened when the shell must hold a credential it cannot re-derive from a one-time paste, or at the first signed artifact. Today: a 0600 file and a browser partition, one implementation |

**The packaging evaluation, recorded now so the later verdict is a confirmation and not a
discussion.** Candidates: `electron-builder`, Electron Forge, and first-party
`@electron/packager` + `@electron/osx-sign` + `@electron/notarize`.

- **`electron-builder`** does the most and is the most opinionated: it bundles `electron-updater`,
  which is a dependency this ADR deliberately defers (§4.1). Taking the packager would smuggle in
  the updater's shape as the default.
- **Electron Forge** is the official toolchain and pulls a plugin layer of its own — a second plugin
  system inside a repo whose entire architecture is one plugin system.
- **The first-party pieces** are three small packages that each do one thing, which is the "boring,
  small, pinned" reading of a build toolchain.

**Leaning, for confirmation at the first artifact: the first-party pieces.** Named as a leaning
rather than a verdict because the deciding evidence — whether notarizing a bundle with a
Bun-compiled signed child actually works under the hardened runtime (§5.2) — does not exist yet, and
a verdict recorded before its own evidence is the thing ADR 0016's precedent argues against.

---

## 8. Deferrals, each with its revisit condition

Every deferral in this file, in one place, because a deferral without a condition is an omission
with better manners.

| #      | Deferred                                       | Revisit condition                                                                                                                        |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | Tauri as the desktop runtime                   | the native-mobile milestone opens (the roadmap's own schedule), **or** §1.3's Electron duty is missed twice                              |
| **D2** | Auto-update, and the update server with it     | a signed artifact exists (§5.2) **and** somebody who is not on `atyrode apply` installs it                                               |
| **D3** | Windows x64/arm64, macOS x64, AppImage, `.deb` | a host of that class needs the lens; Windows' route and price are already stated (§5.3) so the deferral is priced, not blank             |
| **D4** | The hardened-runtime + signed-sidecar proof    | the first signed artifact — and it is the **first** thing that artifact must prove (§5.2)                                                |
| **D5** | OS keychain / Electron `safeStorage`           | the shell must hold a credential it cannot re-derive from a one-time paste, **or** the first signed public artifact                      |
| **D6** | An independent sidecar update channel          | the agent-newer-than-hub direction is guarded in **this** repo (#68's declined third criterion or an equivalent handshake guard)         |
| **D7** | Multi-instance profiles and an instance picker | one principal routinely works two instances from one desktop; ADR 0014's dial path getting real use is the earlier signal                |
| **D8** | Offline behaviour                              | #109 lands; the desktop inherits what it proves and invents no second answer                                                             |
| **D9** | `disable-library-validation` as an entitlement | only if the measurement in §5.2 shows the signed Bun-compiled child cannot launch without it — and then as an amendment with the numbers |

Two things in this file are deliberately **not** deferrals, and are named here so nobody files them
as such. §6.2's host-plugin join field is a **prerequisite** — the prototype's third acceptance
claim is decorative without it. §5.6's two origin seams are **#109's work**, already scheduled by a
ratified ordering, and the prototype's premise depends on them.

---

## 9. Answer index

Every numbered question in #82, answered in one line, so a reader can audit coverage without
reading the argument twice.

| Q   | Answer                                                                                                                                                                                                                                                                                                                                                               | §        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | **Yes** — Electron confirmed on the roadmap's three stated grounds, each checked against this tree                                                                                                                                                                                                                                                                   | 1.1      |
| 2   | **A runtime dependency of the product**, owing the full invariant-8 verdict, an exact pin and a stated update duty                                                                                                                                                                                                                                                   | 1.2      |
| 3   | **Electron 44, exact patch**; patch duty within one week of a Chromium security release, major duty never outside Electron's supported three; **the operator** is on the hook                                                                                                                                                                                        | 1.3      |
| 4   | **defer-Tauri-to-the-mobile-milestone**                                                                                                                                                                                                                                                                                                                              | 1.4      |
| 5   | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no remote module, no `webviewTag`; **yes** — the preload surface is the registered manifests plus one validated `invoke`, nothing ambient                                                                                                                                  | 1.5      |
| 6   | **Both**, precedence: configured → discovered-live → bundled; discovery's one source of truth is `core.machines.list`                                                                                                                                                                                                                                                | 2.1      |
| 7   | The shell supervises a child **only** at rung 3; at rungs 1–2 the service or the existing agent owns the process                                                                                                                                                                                                                                                     | 2.1      |
| 8   | ADR 0016 §6's shape verbatim — three restarts in five minutes, then stop and say so; health is an **observable state** with a closed value list                                                                                                                                                                                                                      | 2.3      |
| 9   | Enrols at rung 3, main-side, name `hostname()`; second install for the same OS user reuses the persisted token and never re-enrols; a second OS user is `<hostname>/<user>`; a row without a token **refuses** rather than rotating (#40)                                                                                                                            | 2.2      |
| 10  | **With the shell** — one artifact, one version (#68); an independent channel is **D6**                                                                                                                                                                                                                                                                               | 2.4      |
| 11  | **A named refusal**, raised **before** the spawn from `/healthz`'s `protocolVersion`; the shell is the first place this failure is visible at all                                                                                                                                                                                                                    | 2.5      |
| 12  | **Minted-token** — and no root secret at rest anywhere in the shell                                                                                                                                                                                                                                                                                                  | 3.2      |
| 13  | **`core.access.mint`** (not `createPrincipal`, which mints `["*"]`); caps `containers:read, scenes:write, terminals:spawn, terminals:write`; revocable by `core.access.revoke` like any principal                                                                                                                                                                    | 3.3      |
| 14  | Lens token → the renderer partition's `manifold.identity`; machine token → a 0600 file passed as `MANIFOLD_MACHINE_TOKEN_FILE`; owner key → **nowhere**. **One** implementation, not three. Keychain is **D5**                                                                                                                                                       | 3.3      |
| 15  | A **forcing function** for #58, deliberately upstream: expressible today, consumes #108's revoke list when it lands, and adds one requirement — a principal whose name says which host it is                                                                                                                                                                         | 3.4      |
| 16  | **One instance per window**; the credential is scoped to the normalized instance origin. Picker and profiles are **D7**                                                                                                                                                                                                                                              | 3.5      |
| 17  | **Operator** — auto-update is **D2**, behind its own invariant-8 verdict                                                                                                                                                                                                                                                                                             | 4.1      |
| 18  | ADR 0016 R8's three rules apply **verbatim**: fail-closed verification, a pinned hash re-verified at load, registry review is not a security control. The server is part of D2's verdict                                                                                                                                                                             | 4.2      |
| 19  | **The existing dev/stable channels.** The shell's version is the repo's release tag; no second vocabulary                                                                                                                                                                                                                                                            | 4.3      |
| 20  | No shell-lens skew exists (§3.1); the bundled agent **refuses visibly** in the unguarded direction; the host-plugin field is additive-optional so both directions degrade to ordinary absence; **no** self-update                                                                                                                                                    | 4.4      |
| 21  | **macOS arm64 + Linux x64.** Linux form: a Nix flake output plus a plain tarball. macOS x64, Windows, AppImage, `.deb` are **D3**                                                                                                                                                                                                                                    | 5.1      |
| 22  | **Notarized** for the shipped artifact: $99/yr Apple Developer Program, a Developer ID Application cert, `codesign` + `notarytool` + staple, hardened runtime with `allow-jit`, `disable-library-validation` **rejected** (**D9**), the sidecar signed with its own signature. The hardened-runtime proof is **D4**                                                  | 5.2      |
| 23  | **Azure Artifact Signing** when Windows lands — $9.99/month up to 5,000 signatures — chosen for **key custody**; OV/EV rejected on custody grounds; unsigned stated plainly with the SmartScreen consequence, including that it earns no reputation toward a later signed identity                                                                                   | 5.3      |
| 24  | Secrets on the **one** workflow allowed to publish; **only the operator** runs a release; **no agent** runs it (#68's declination); the blast radius is stated                                                                                                                                                                                                       | 5.4      |
| 25  | **In this repo**, as **`packages/desktop`** — not `shell`, which `core.shell` owns (§Lexicon law). Registry edits: this ADR's awaiting row now; later a `desktop` lexicon row, a gate-contract row for the purity check, and one sentence of §Pillar inventory prose saying a **host** is neither floor nor plugin (`packages/testkit` precedent). **No pillar row** | 5.5      |
| 26  | **PWA-first** — already ruled. The dependency is concrete: `sessionUrl()` and `api.ts`'s relative `fetch`, plus the offline story                                                                                                                                                                                                                                    | 5.6      |
| 27  | Confirmed, with the four claims and the mechanism each requires — including the purity check that does not exist yet (§6.5) and the join field (§6.2)                                                                                                                                                                                                                | 6.1, 6.3 |
| 28  | **Yes**, amended twice: the renderer loads the **instance's served** bundle, and the capability is the **OS notification**, not the tray                                                                                                                                                                                                                             | 6.1      |
| 29  | **Confirmed**, amended by adding six: a bundled web dist, a second agent channel, offline behaviour, any surface beyond the one plugin, any `packages/web/src` edit other than the neutral seam, and any wire change other than §6.2's field                                                                                                                         | 6.4      |
| 30  | **Decide, then build** — already ruled. Measurement is allowed as a `docs/spikes/` throwaway whose numbers are not quotable as benchmarks; a spike with a `package.json` under `packages/` has stopped being a spike. **No spike was needed for this file**                                                                                                          | 6.6      |

---

## 10. Ratification asks

What a yes decides, phrased so each can be answered on its own. A no to any one of them leaves the
rest standing.

- **R1.** Is **Electron** confirmed as the desktop runtime, classified as a **runtime dependency of
  the product** under invariant 8, pinned to an **exact 44.x**, with §1.3's patch duty, major duty
  and named owner? (yes / no)
- **R2.** Is the **sidecar precedence** — configured → discovered-live → bundled, with
  `core.machines.list` as discovery's one source of truth and no local probe — adopted? (yes / no)
- **R3.** Is the **auth posture** adopted: `core.access.mint` with the four named caps, the owner key
  used once in main and **never persisted**, and the three-row storage answer of §3.3 with a
  keychain deferred? (yes / no)
- **R4.** Is **§6.2's host-plugin join field** authorized — one additive-optional field, `source:
"host"` roster rows, a dedicated `protocol:` commit — as the prototype's prerequisite? This is the
  largest thing in this file and the one place it touches the wire. (yes / no)
- **R5.** Is the **first target set** macOS arm64 + Linux x64, with the signing bill of §5.2 accepted
  as a bill to be paid at the first artifact and Windows deferred at the stated price? (yes / no)
- **R6.** Is the **prototype scope** of §6.1 with the four acceptance claims of §6.3 and the
  exclusion list of §6.4 the prototype — including the new browser-purity gate check (§6.5) as part
  of its change? (yes / no)
- **R7.** Is **`packages/desktop`** the package name, with `shell` refused on §Lexicon law grounds
  and `sidecar` refused as tree vocabulary, and is the **host-is-neither-floor-nor-plugin** finding
  (no pillar row, `packages/testkit` precedent) accepted? (yes / no)
- **R8.** Are the **nine deferrals** of §8 accepted with the revisit conditions as written? (yes /
  no — and if no, which condition is wrong)

A yes to R1–R8 does **not** authorize a line of shell code by itself: it makes this record ratified,
after which the prototype is an ordinary change against a decided design. That ordering is #82's
ruling and this file's whole reason for existing.
