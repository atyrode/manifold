# 0019 — Identity is layered: the owner key is the bootstrap, and one layer may sit above it

Date: 2026-09-01
Status: **ACCEPTED — ratified by the operator, 2026-09-01.** This is the dated record #58's first
acceptance criterion asks for. The posture below is normative; the NOW items in §2–§4 are the work
it obliges, and #58 stays open until they land.

## Context

manifold's only authentication primitive is the owner key: a 64-hex secret read from
`<data>/owner.key`, carried in a URL fragment (`#key=…`, the one sanctioned secret carrier under
invariant 6), persisted to `localStorage`, and minted into per-principal bearer tokens.
`AuthService.authenticate` (`packages/server/src/auth.ts:297-322`) has exactly two paths and no
third: `secretsEqual(raw, this.ownerKey)` at `:298` — a `timingSafeEqual` over `Buffer`s
(`secretsEqual`, `:96-101`) — returning `caps: ["*"]`, `containerScope: null`, `isRoot: true`,
`tokenId: null`, `grantId: null`; or a hashed bearer token at `:309`, refused if absent
(`unauthorized`) or revoked (`forbidden`). That is the entire identity layer.

Two waves have since moved everything around it and neither touched it, which is what makes this
decision answerable now rather than earlier:

- **The permission waterfall** (ADR 0011, #77/#78) replaced authority with grant rows on the node
  tree, beneath `AuthService.allows`, with the signature and all 27 call sites unchanged and
  `PROTOCOL_VERSION` still 18. It added exactly one field to `AuthContext` — `grantId` — which
  answers _what this credential may do_ and never _who presented it_. Revocation is now a row
  deletion that bites on the next dispatch through the `onRevoked` fence (`auth.ts:1045`).
- **Cross-instance sharing** (ADR 0014, #74) made `Principal.origin` real and made shares grant
  rows. It also made the posture worse in one specific way, which ADR 0015 §5 names: an inbound
  dial is admitted by holding a valid share secret and nothing else — possession is authority, and
  there is no accept-list above it.

So the asymmetry is now sharp: manifold can express fine-grained, auditable, instantly revocable
authority over a subject it cannot authenticate beyond "holds a secret". The waterfall also proved
the prediction #58 was filed with — an entire authority model was replaced beneath `allows()`
without a protocol bump or a call-site change, so **an identity layer is additive**: it sits in
front of `createPrincipal` (`auth.ts:465`) rather than replacing the capability model.

Nothing is broken today. This file exists so that the current model is a **choice on the record**
rather than an accident of the bootstrap path, and so that the answer does not have to be invented
under pressure by whoever first deploys manifold for two humans.

## The posture: layer, never replace

### 1. The owner key stays forever, as bootstrap and break-glass

It is not a transitional artifact to be deleted when something better arrives. It is what makes
`docker compose up` work offline in ten seconds, it is what recovers an instance whose identity
layer is misconfigured, and it is the only credential that exists before any principal does. Every
option below is **layered above** it and none removes it. Concretely, and permanently:

- The localhost single-operator path takes no external service, no DNS record, no OAuth app
  registration and no network. One command, offline, forever.
- **Agent credentials never route through a human login flow.** Machine tokens and per-principal
  bearer tokens are minted non-interactively today and stay that way; an identity layer that made
  an agent wait for a redirect would violate A2, which is the reason D below is a relying party in
  front of `createPrincipal` and not a gate in front of `authenticate`.
- Owner-key rotation stays a file swap plus a re-bootstrap of interactive browsers, and does **not**
  disturb enrolled machines, because machine tokens are independent credentials. That procedure is
  owed in `docs/SELF-HOST.md` (§Acceptance below).

### 2. Now: session expiry

There is no expiry anywhere today — no `expires_at` column on a token row, no session lifetime, no
idle bound. A key pasted into a browser two months ago still authenticates. The NOW item is a
bounded credential lifetime with an explicit, documented default, expiry enforced at
`authenticate` beside the existing revocation refusal, and a named refusal a lens can act on rather
than a generic `unauthorized`. Machine tokens are the deliberate exception: an agent's credential
is long-lived by design, and shortening it is a fleet outage wearing a security hat.

### 3. Now: the principal and device list, with revoke

The data exists and is unreachable by anyone who is not root: `GET /api/introspect`
(`packages/server/src/http.ts:328-341`) publishes principals and machines to a root caller, and
nothing else does. There is no list a human can look at, and no way to answer "which browsers hold
my key" at all. The NOW item is that question made answerable and actionable: every principal, its
kind, its origin when it has one, its live sessions and its enrolled machines, each with a revoke
affordance in the workspace.

One asymmetry has to be named because it decides part of the work. Revoking a **principal's**
credentials already has a door — `core.access.revoke`, `caps: ["tokens:mint"]`, `cleanup: true` —
and it severs live sockets through the fence that already exists (`AuthService.onRevoked`,
`auth.ts:1045`). Revoking a **machine** does not: `core.machines` publishes `list` and `enroll` and
nothing else, so a credential minted for "a process nobody in this workspace can see" — the
manifest's own words for why `machines:mint` is load-bearing — currently cannot be withdrawn
through any door. The mechanism exists one level down — `rotateMachineToken` revokes a machine's
token and writes `token_revoked` when it rotates the secret (`auth.ts:644-654`) — so the missing
piece is withdrawal as an ACT, which the workspace has no way to ask for. So this item is a list
plus **one new door**,
not a list plus a rendering pass, and the door is the reason it is a NOW item rather than a UI
chore. It stays one door per concept: revoking a machine is revoking that machine's credential, and
there is no second spelling of it.

This is the neighbour of ADR 0011 §8's grant-UI deferral and not the same thing: that list is
about grant rows, this one is about **credentials**.

### 4. Now: bootstrap audit, in the journal the ledger reads

Every use of the owner key is invisible. Grants, tokens and dispatches are all recorded —
`token_minted`, `token_revoked`, `grant_created`, `grant_revoked`, and the trace ledger of ADR 0018
— but the one credential that is root everywhere leaves nothing behind. The NOW item is that an
owner-key authentication, and a principal created through the bootstrap path, each leave a durable
row read through `core.events.list`, which is the same door and the same retention as everything
else A6 covers.

**It is an event row, not a `trace` row, and that is deliberate.** A trace row's `door` field is
"the full action name — the door, as the roster publishes it" (`TraceAttribution`,
`packages/server/src/stores.ts:399-413`), and an authentication has no door; synthesizing one would
put a name in that column that the roster does not publish, which is exactly the lie
`verify:trace` T3 exists to catch. Widening ADR 0018's one-writer rule instead — `appendTrace` and
`settleTrace` are called from the store that defines them and the dispatch ladder that uses them
and nowhere else, mechanized by T1 — was **rejected**: it would trade a checkable invariant for a
column that does not fit. The audit therefore rides the ledger's journal and its one reader, not
its writer.

### 5. Documented: reverse-proxy access control as a deployment mode

For deployments that want real authentication before manifold sees a request, the answer is an
authenticating proxy in front of it — Cloudflare Access, Tailscale, an OIDC-terminating proxy —
and that answer is **documentation, not a product feature**. It costs manifold zero runtime
dependencies, works today with no code, and is what a self-hoster who already runs a proxy
expects. It is not sufficient on its own: it authenticates the _edge_ and manifold still cannot
distinguish two humans behind it, which is what §6 is for.

### 6. When multi-human becomes real: OIDC relying party in front of `createPrincipal`

manifold becomes a **relying party only** — any provider, self-hosted Keycloak/Authentik/Dex
included — and never stores a credential. It sits in front of `createPrincipal`, so a successful
login maps an external subject to a principal and the capability model beneath is untouched; the
owner key remains the bypass, which is what keeps the localhost floor at zero. This is not
scheduled and no code is owed today. Its trigger is in §Revisit when, and its dependency verdict
under invariant 8 is owed in the ADR that implements it, not here.

## Alternatives rejected

- **First-party accounts** (email plus password or passkey, sessions in SQLite). Rejected. It means
  owning credential storage, reset flows and rate limiting — the "don't roll your own auth" trap —
  in a project whose axiom is _small_ (A6), and it buys nothing the owner key plus §6 does not,
  except provider-less multi-human operation. If provider-less multi-human ever becomes a hard
  requirement, this is the option that returns, and it returns as its own dated record.
- **A bundled identity provider** (Keycloak, Authentik). Rejected outright, for the default path and
  as an option. A heavyweight Java or Django service beside a one-Bun-process tool would dominate
  the deployment story and be the largest dependency manifold has ever taken. Pointing §6's relying
  party at an IdP the operator _already runs_ is the same capability at none of the cost.
- **Adopting a social or federation protocol to get identity** (Matrix, XMPP, ActivityPub).
  Rejected in ADR 0015 §1, ratified the same day. Identity was one of the five nouns that row
  promised, and this file is where that noun went.
- **Deferring the whole question again.** Rejected. Deferring costs nothing while there is one
  human, which is precisely why it would be deferred forever, and the first deployment that needs
  an answer is the worst moment to design one. The three NOW items are cheap, additive, useful to a
  single operator on their own terms, and the parts of any future layer that get built first
  regardless.
- **Making the owner key expire or become revocable by grant.** Rejected as incoherent with §1: it
  is the break-glass path, and a break-glass credential that can be locked out is not one. Its
  undeniability is already a property of the evaluator rather than a row that can lose a precedence
  fight (ADR 0011 §5), and that stays true.

## What #58's acceptance criteria mean under this posture

Restated as the record, so the issue's remaining debt is unambiguous when this file is read alone:

1. **A dated decision record naming the chosen posture, the rejected alternatives and the revisit
   trigger.** Discharged by this file.
2. **The localhost single-operator path still works with no external service and no network, in one
   command.** Guaranteed by §1 permanently, and a constraint on every item in §2–§6 rather than a
   thing to re-verify per wave.
3. **Agent credentials remain non-interactive and independent of any human login flow.** §1, and the
   reason §6 sits in front of `createPrincipal` instead of `authenticate`.
4. **`docs/SELF-HOST.md` states the security posture plainly** — what the owner key does and does
   not protect, so a self-hoster can make an informed choice. **Still owed**, and it now has a
   posture to state: fragment carriage, no expiry until §2 lands, root-everywhere authority, and
   the proxy deployment mode of §5.
5. **Owner-key rotation has a documented procedure that does not disrupt enrolled machines.**
   **Still owed.** The behaviour already holds — machine tokens are independent credentials — so
   what is missing is the written procedure, not the mechanism.

Items 4 and 5 are documentation obligations on #58, which stays open for them and for §2–§4.

## Tensions with landed decisions

Flagged, not resolved.

- **The undeniable owner is an identity question wearing authorization clothes.** ADR 0011 §5 makes
  owner authority a property of the evaluator, so deny rows cannot narrow a credential acting as
  the owner principal. Under §1 that is confirmed rather than merely tolerated — the owner key is
  break-glass and break-glass must not be deniable — but it means "the owner" is one principal
  identified by one secret whose only defence is that it has not leaked. §2 and §3 are what reduce
  that exposure without touching the rule.
- **The deny-attenuation rule waits here.** ADR 0011 §8, settled 2026-09-01: the grant doors stay
  root-only and the candidate deny-attenuation rule is deferred to this milestone, because both
  halves of it ("the writer", "a principal whose effective set exceeds the writer's") are identity
  predicates. When §2–§4 land, that rule is decidable and is decided with them.
- **Administered allow widens a live credential with no re-authentication.** Confirmed as A5 taken
  literally (ADR 0011). Its identity coupling is that a class grant is only as trustworthy as
  principal creation is, and principal creation is exactly what §6 would put a login in front of.
- **Cross-origin admission is possession-based.** ADR 0015 §5 and its ask R5, ratified as written
  2026-09-01: a default-deny origin accept-list is owed by the wave that next touches admission.
  That is an _instance_ identity question, and ADR 0015's R6 (URL-origin identity versus a keyed
  instance identity) rides the waterfall wave's `kind: "instance"` grants. This file is about
  authenticating **humans and agents to this instance** and does not settle either.
- **A desktop shell is a forcing function.** #82 asks whether the shell hands the lens the owner key
  or mints a token immediately (its questions 12–15). Under §1 the owner key is available to it, and
  under §3 the minted-token answer becomes strictly better because a shell's principal would then be
  visible and revocable like any other. The shell ADR decides it; this file makes both answers
  expressible.

## Revisit when

**Multi-human becomes real** — a second human, not a second browser, holds authority on an instance
somebody operates. That is §6's trigger and the one that matters. Also: if provider-less multi-human
operation becomes a hard requirement (then first-party accounts return as their own dated record);
or if manifold is ever deployed on a public origin without a proxy in front of it (then §5 stops
being a deployment mode and the posture needs re-arguing); or when the waterfall implements
`kind: "instance"` grants, which is where instance identity — a neighbour of this question and not
this question — becomes decidable.
