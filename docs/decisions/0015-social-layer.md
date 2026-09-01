# 0015 — The social layer: identity, contacts, invitations and chat

Date: 2026-08-31
Status: **PROPOSED — awaiting operator ratification.** Nothing here is normative until the
§Ratification asks are answered. No code depends on this file.

## Context

`AXIOMS.md` §Roadmap carries a later wave in these words: a `core.social` plugin — "identity
beyond a device-local grant, friends, invites, agent chat, share-invitation signaling" — with
**Matrix ratified as the leading candidate**, to be judged at that wave against ActivityPub and
plain invite links in its own dated ADR, and **rejected as foundation** because adopting it below
the floor would install a second room model, a second event model and a second permission model
beside manifold's own. This file is that judgement. The rejection-as-foundation is settled law
and is not reopened; what is open is whether Matrix — or XMPP, or ActivityPub — is the substrate
of a plugin, and what that plugin is allowed to be.

Three things changed since the roadmap row was written, and all three narrow the question.

**Wave 2 landed the event plane** (ADR 0012): declared notifications emitted at the doors, topics
that are `manifold://` nodes, admission discharged as a read-grant walk, and explicitly **no queue
semantics** — no offsets, no replay, no delivery guarantee beyond "delivered to the sockets
subscribed at the time of emission". That clause decides more of this ADR than any protocol
comparison below: a chat message that must survive a reload is not an event, and no amount of
social framing makes it one.

**Wave 3 lands cross-instance sharing** (ADR 0014, same night as this file). Its vocabulary is
frozen and this file uses it rather than inventing a second one: the **instance channel** at
`/ws/instance` is control-only, the guest dials out to the host and the two exchange
`hello`/`welcome`/`ping`/`pong`/`ticket_request`/`ticket`/`ticket_error`; a **share** is a token
bound to a node, minted and revoked through `core.access.mintShare` / `revokeShare` /
`listShares`, dialled from the guest side with `dialShare` / `openDial`; projection is not relayed
at all — the guest's own lens dials the host's ordinary `/ws/session` with a per-principal
**ticket**, so a remote viewer is just another authenticated participant in the host's room; and
`Principal.origin?: string` is the instance's normalized public base URL, absent meaning local,
normalized by `normalizeInstanceOrigin()` (`packages/protocol/src/origin.ts`). A cross-instance
reference is the **`(origin, ref)` pair**; `manifold://` gains no authority component this wave.

**Wave 1 landed the seats.** Thirteen packages under `packages/plugins/*` publish fourteen core
plugin ids today (`core.shell` and `core.space` share the shell package), and
`AGENTS.md` §Conventions makes roster restraint a rule with teeth: "a new core plugin needs the
same justification discipline as a new pillar … extending an existing seat beats adding a new one,
and an opinionated feature belongs on the roadmap or in a third-party plugin — never in the box by
default." A social layer is the single most opinionated feature anybody has proposed for manifold,
and it arrives with one more seat in its hand.

The evidence below was read from specifications, package metadata and vendor documentation on
2026-08-31; every number is sourced, and what could not be verified is marked.

## What each candidate actually costs

### Matrix (spec v1.19)

- **A homeserver is mandatory.** Identity is `@localpart:domain` where the domain "is the server
  name of the homeserver which allocated the account" (spec appendices); federation is
  server-to-server signed PDUs. There is no client-only participation mode. Synapse v1.159.0
  (2026-08-18) is Python/Twisted plus Rust, and its own installation docs say "SQLite is only
  acceptable for testing purposes. SQLite should not be used in a production server" — so adopting
  Matrix adds **PostgreSQL** to a product whose entire operational story is one SQLite file
  (`REGISTRY.md` §Pillar inventory, `persistence`). The alternatives are not a way out:
  `matrix-org/dendrite` is archived (last push 2024-11-25), `element-hq/dendrite`'s latest release
  is v0.15.2 from 2025-08-15, and the Conduit lineage has renamed itself out from under its own
  GitHub identity (`girlbossceo/conduwuit` no longer resolves; the live fork is
  `matrix-construct/tuwunel` v1.9.0, 2026-08-19).
- **The client dependency is not small.** `matrix-js-sdk@42.2.0` declares 11 runtime dependencies;
  a clean install measures **16 packages / 27 MB**, of which `@matrix-org/matrix-sdk-crypto-wasm`
  is 8.6 MB including a **7.5 MB `.wasm`** — and it sits in `dependencies`, not
  `optionalDependencies`, so the tree pays for E2EE whether or not E2EE is switched on. It declares
  `engines.node >= 22.0.0`; whether it runs under Bun is [unverified]. The Rust SDK is not an
  escape either: `matrix-sdk-ffi` has never been published to crates.io (only a `0.0.1-reserved`
  placeholder from 2022), so using it means a Rust toolchain and UniFFI codegen in CI.
  Invariant 8 (no new runtime dependency without a dated ADR) is satisfiable here only by writing
  the 7.5 MB down as a considered price.
- **It brings the second permission model the axioms already refused.** An `m.room.power_levels`
  event maps a user id to an **integer**, compared against integer thresholds: `invite` defaults to
  0, `kick` and `ban` to 50, `state_default` to 50, `events_default` to 0, and in room version 12
  creators hold infinite power and must not be listed at all. That is the whole authority model,
  and it is not expressible in — nor expressive of — A5's grant rows (principal or class, node,
  caps, effect, reach, walked root-to-node with deeper beating shallower). Two models, one
  question, which is exactly the outcome `AXIOMS.md` §Roadmap forbade below the floor. A plugin
  does not make the second model disappear; it only moves it one directory.
- **Moderation is a permanent operational post, not a feature.** The abuse pressure is severe
  enough that spec v1.19 added a **third daemon class** — Policy Servers, with
  `GET /.well-known/matrix/policy_server`, `POST /_matrix/policy/v1/sign` and an `m.room.policy`
  state event. Server ACLs carry their own defeat in the spec text: "Server ACLs are only effective
  if every server in the room honours them. Servers that do not honour the ACLs may still permit
  events sent by denied servers into the room, leaking them to other servers in the room."
  Reporting endpoints (`/rooms/{roomId}/report`, `/users/{userId}/report`) deliver to the local
  admin, which means whoever runs a manifold instance becomes an abuse desk for a federation they
  did not join deliberately.
- **A client must tolerate twelve simultaneously-valid room versions**, with "no implicit ordering
  or hierarchy" between them, and the third-party-identifier story is being withdrawn (`id_server`
  is "deprecated with a plan to be removed in a future specification version").

### XMPP

- **The server side is genuinely cheaper.** Prosody is Lua, ships SQLite as a first-class storage
  backend (LuaSQLite3, 13.0+), and needs LuaEvent only "for efficiently scaling above hundreds of
  concurrent connections"; ejabberd 26.07 (2026-07-30) is actively maintained Erlang. Client-side,
  `strophe.js@5.0.0` has **zero runtime dependencies** — a fraction of Matrix's footprint.
- **The specification surface is the cost.** A minimum for contacts + a shared room + invitations
  is RFC 6120 + RFC 6121 (roster and presence subscription come free, no XEP needed) plus
  XEP-0030 Service Discovery, XEP-0004 Data Forms, XEP-0045 MUC and XEP-0060 PubSub. The modern
  replacement for MUC, **MIX (XEP-0369), has been Experimental since 2015 and its last revision is
  2020-12-01** — a family of eight documents requiring MIX-CORE on the channel server and MIX-PAM
  on every participant's server, so it cannot be adopted unilaterally. **OMEMO (XEP-0384) is still
  Experimental** at v0.9.1 with the standard "carefully consider whether it is appropriate to
  deploy" warning after eleven years.
- **The identity failure mode is identical to Matrix's.** RFC 7622 §3.1: "The domainpart is the
  primary identifier and is the only REQUIRED element of a JID." Whoever holds the domain issues
  the identity, and there is no portability.
- **The most useful thing XMPP tells us is an anti-argument.** Prosody ships `mod_invites` with a
  dedicated **`invite_token` store** — inside a federated chat protocol, onboarding is still
  implemented as an opaque token, not as a protocol message.

### ActivityPub (W3C Recommendation, 2018-01-23, unmodified)

- The Recommendation contains **zero occurrences of "presence", "typing", "real-time", "latency",
  "encrypt" or "WebFinger"** (verified by grep over the full REC). Its only timing language is
  §7.1's "delivery SHOULD be performed asynchronously". Every capability this wave is about —
  live presence on a shared node, an invitation answered in seconds, an agent conversation — is
  out of scope by construction, so adopting AP would mean building all of it ourselves and
  inheriting a publishing model on top.
- **The spec specifies no authentication at all.** §B.1, in full: "Unfortunately at the time of
  standardization, there are no strongly agreed upon mechanisms for authentication." The wire
  signing everybody implements comes from an expired IETF draft as codified by Mastodon. The real
  interop contract is another product's behaviour, which is precisely the dependency shape
  invariant 8 exists to make deliberate.
- Addressing is advisory: `bto`/`bcc` privacy "depends on every receiving server honouring it",
  and an actor's identity is an HTTPS URL you must keep serving forever.

### The boring alternative, and the precedent that names it

Systems that do cross-instance identity and invitation **without** adopting a chat protocol all
converge on one shape: identity is either a public key or an account on the server that issued it,
and the invitation is an opaque token or a pasted identifier.

- **Syncthing** — the closest match to manifold's problem. A device ID _is_ the key: SHA-256 of the
  DER certificate, base32, 52 characters with per-group check digits; the peer's ID is recomputed
  from the certificate at handshake and the connection is dropped if it is not in config. The
  friend-of-friend feature is the **introducer**: two connected devices exchange the devices
  attached to their mutually shared folders. The operator runs nothing mandatory.
- **Tailscale** — key identity plus token enrolment: per-device node keys (default 180-day
  expiry), auth keys `tskey-…` one-off or reusable with 1–90 day expiry, revocable — over a
  central coordination server.
- **iroh** — an `EndpointID` is an Ed25519 public key, and its documentation gives manifold its
  answer directly: "If you have any means of coordinating (a database, server, or gossip
  protocol), we recommend you work with EndpointIDs directly instead of tickets." manifold has
  both a database and a server.
- **Zulip** — the plain-web precedent for "invitations to a shared node": a reusable invitation
  link with a chosen expiry and a pre-assigned role, revocable by an owner.

Wave 3 already built manifold's version of this and did not need a protocol to do it: a share is a
token bound to a node, hashed at rest, revoked through `core.access.revokeShare`, and the dial is
one long-lived control channel. What the social roadmap row asks for, minus the chat protocol, is
mostly **already shipped**.

## Decision

### 1. No social protocol is adopted, as foundation or as substrate

Matrix, XMPP and ActivityPub are all **rejected as the substrate of manifold's social layer**.
Matrix's demotion is the substantive change this ADR proposes: `AXIOMS.md` §Roadmap's "Matrix is
the ratified leading candidate" becomes "Matrix is an optional third-party **bridge**, never in the
box" (§6). The reasons are ordered by how much they cost:

1. **A second permission model.** Power levels are integers per room; A5 is grant rows on a node
   tree. Whichever one answered a given question would be the one nobody audited.
2. **A second durability and delivery model.** Matrix rooms are a signed event DAG with state
   resolution; ActivityPub is retrying HTTP delivery into `OrderedCollection`s; manifold's answer
   is SQLite plus a Yjs document plus an event plane with no replay. Three ordering authorities.
3. **A second operational contract.** Postgres, a homeserver, a policy server and an abuse desk,
   for a product whose §Budgets ceilings are currently zero network reads at idle.
4. **They do not do the thing.** The only two capabilities manifold genuinely lacks —
   a message that survives a reload, and a name for a person on another instance — are one
   durable table and one string. Everything else in the roadmap row is landed.

### 2. There is no `core.social` seat

The recommendation is **third-party-only for anything recognisably "social", and no new seat in
the default distribution**. The roadmap row's five nouns are not one feature; they are
four already-owned obligations and one genuinely missing mechanism, and giving them a shared
package would create the opinionated seat roster restraint exists to refuse.

| Roadmap noun                   | Where it actually lands                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity beyond a device grant | `Principal` + `Principal.origin` (ADR 0014). Landed. Nothing owed.                                                                                                                  |
| share-invitation signaling     | `core.access.mintShare` / `revokeShare` / `listShares` plus the instance channel's `ticket_request` / `ticket` exchange (ADR 0014). Landed.                                         |
| friends / contacts             | §3 — a contacts ledger on `core.access`, the seat that already owns "who exists and what they may do".                                                                              |
| agent chat / DM                | §4 — the **Notifications** wave's durable addressed message. Not a new plane, not an event, not a new seat.                                                                         |
| presence on a shared node      | `core.presence`, unchanged: wave 3 makes a guest an ordinary participant on the host's session channel, so vantage and attendance already cross (A4). §5 names the one consent gap. |

### 3. Contacts are a ledger on `core.access`, keyed by the `(origin, ref)` pair

A contact is a remote identity this instance has accepted, stored as ADR 0014's cross-instance
reference and not as a second spelling of one: the pair
`{ origin, ref: { kind: "principal", id } }`,
where `origin` is exactly what `normalizeInstanceOrigin()` produces and nothing else. It is stored
in `core.access`'s own `ctx.storage` namespace — no new table, no new pillar — and administered by
three doors beside the share doors it already publishes:

- `core.access.rememberContact { origin, ref, label? }` — cap `tokens:mint`, scope
  `workspace`. Accepting a contact is the act that lets a share be minted to them, which is why it
  sits behind the minting capability rather than a new one.
- `core.access.forgetContact { origin, ref }` — cap `tokens:mint`, `cleanup: true` is
  **refused** for it: forgetting is administration, not removal of something the plugin created
  (S10's verb list, ADR 0013 §9).
- `core.access.listContacts {}` — cap `tokens:mint`, scope `workspace`. `CAPS`
  (`packages/protocol/src/capabilities.ts:11-21`) has no read-only token capability, so reading
  the ledger sits behind the same administrative cap as writing it; minting one — `tokens:read`
  — is a lexicon and capability addition this file does **not** propose, and is the obvious
  amendment if the operator wants the reads separable (§Ratification ask R4).

Two rules keep this from becoming a social graph. **A contact is local and asymmetric**: there is
no handshake, no "friend request" state machine, no acceptance protocol between instances — A
remembering B says nothing about B's ledger, exactly as a Syncthing device list is one side's
config. And **a contact grants nothing**: it is a name and an address, and every capability still
comes from a grant at a node (A5). A contacts ledger that conferred authority would be mount-time
authority wearing a friendlier word, which ADR 0010 rejected by name.

### 4. A direct message is a durable notification, not an event and not a plane

The event plane refuses this work on purpose (ADR 0012 §5: no offsets, no replay, catch-up is
reading state), and it is right to. A message addressed to a person who is not connected is
precisely the **Notifications** roadmap wave: "durable, addressed messages that outlive a tab …
persistence, a per-principal read/unread state and a delivery door". Chat is that mechanism with a
thread id and a body, and manifold should discover whether it wants chat _after_ it has
notifications, not by shipping a chat product to obtain a message table.

Three consequences, stated so the deferral is a design and not a gap:

- The delivery door is an action, the durable row is a table owned by the notifications seat, and
  the live tap is an event on `manifold://principal/<id>` announcing that a durable message
  exists — the notification's _arrival_ is a fact about a node and carries no body, so §5 of ADR
  0012 stands unamended.
- Agent chat is not a distinct feature. A2 says a capability is reachable identically by a human
  and an agent; a message door that only humans can call would be an A2 violation, and one that
  both can call is "chat" already.
- The `notice` word is not touched. A notice is the transient per-connection message stack
  (`REGISTRY.md` §Lexicon); a durable addressed message is a notification. A plugin raising a
  notice must not silently become a plugin sending mail, which the roadmap already says.

### 5. What crossing an origin costs, written down

- **Admission.** An inbound dial is admitted today by holding a valid share secret. That is the
  Tailscale reusable-key hazard restated: possession is authority, and there is no accept-list
  above it. This ADR recommends a **default-deny origin accept-list** on the host — an instance
  admits dials only from origins an operator or a contact record has accepted — because the
  alternative is that the first spam vector manifold ever has is also the one that can open a
  session channel. This is ratification ask R5, not a unilateral ruling.
- **Moderation, enumerated honestly.** With no protocol adopted, manifold's entire moderation
  vocabulary is: revoke the share (`core.access.revokeShare`, which severs live connections
  through the existing `auth.onRevoked` fence), forget the contact, and refuse the origin. There is
  **no** reporting endpoint, no directory, no abuse queue, no rate limit on invitations, and no
  block list that survives a re-mint. That is a defensible position for a tool whose sharing is
  invitation-only and revocation-first; it is not a defensible position for anything discoverable,
  which is the strongest argument for never building a directory.
- **Identity is domain-bound and has no cryptographic continuity.** `origin` is a URL origin, not a
  key. Lose the domain and every contact row pointing at it is dead, with no `Move` and no
  portability — the same failure mode as an MXID and an ActivityPub actor URI, arrived at
  independently. Every non-federated precedent surveyed (Syncthing, libp2p, iroh, Tailscale) uses a
  **public key** as the identity and treats the address as mutable routing data. Adopting that
  would be a genuinely new authority primitive: ADR 0011 already reserves
  `principal: { kind: "instance"; origin: string }` for federation grants, and a keyed instance
  identity is a change to what that row means. It belongs to the waterfall wave, is named here as
  ratification ask R6, and is **not** decided by this file.
- **Presence across origins is already live, and one consent question is open.** Because a guest is
  an ordinary participant on the host's session channel, `vantage` and attendance cross for free —
  including `core.presence.focus`, which writes a spotlight into a peer's presence. A remote
  principal driving a local principal's viewport is exactly A2's "drivable where consent allows",
  but the existing consent is the local `manifold:ignore-spotlight` kill switch, which was designed
  when every peer was in the same workspace. §Ratification asks R7.
- **A remote principal never calls a door on the far instance.** Wave 3 keeps every door local —
  the host mints and revokes at container scope, the guest dials and opens at workspace scope,
  and only control frames cross — and a ticket is container-scoped, which ADR 0013 §15's scope
  rung refuses at any action declaring `scope: "workspace"`. Every door proposed above (contacts,
  and any future message door) is workspace-graded, so **nothing a remote contact does can reach
  them**: a symmetric act needs either a new control frame on the instance channel or a real
  `kind: "instance"` grant. This is the sharpest constraint in this file and it is flagged, not
  resolved: see T3.

### 6. Matrix, if it ever arrives, is a third-party bridge and never a seat

The bridge shape was measured rather than assumed. The Application Service API (spec v1.19)
requires a registration file with six required fields (`id`, `as_token`, `hs_token`,
`sender_localpart`, `url`, `namespaces`), and **self-registration was removed as a security risk**
— so shipping a bridge means asking every deployer's homeserver admin to install a file and
restart. The homeserver pushes transactions to `PUT /_matrix/app/v1/transactions/{txnId}` and "MUST
NOT alter … events they were going to send within that transaction ID on retries", so the bridge
owes idempotency keyed on `txnId`. An application service is **passive**: it "cannot prevent events
from being sent, nor can [it] modify the content of the event being sent" — so it can never be a
policy point for manifold's authority. And double-puppeting, which is what makes a bridged message
appear as the actual person, is not in the spec at all; the mautrix mechanism is a _second_
registration with a non-exclusive `@.*:your\.domain` namespace and "requires administrator access
to the homeserver, so it can't be used if your account is on someone else's server".

That is a coherent thing for a stranger to build against the manifest and a lunatic thing to put in
the default distribution. Which is the whole point of A1 being about mechanism: the bridge needs
nothing from the floor that a plugin does not already have.

One honest consequence of saying "third-party" twice in this file (§2 and here): a third-party
plugin cannot be installed until the marketplace wave lands, and that wave is hard-gated on the
isolation ADR (`AXIOMS.md` §Roadmap; ADR 0016, proposed the same night). So "social is a
third-party plugin" means "social is not available at all until a runner is ratified and
distribution is built" — which is a schedule this ADR accepts deliberately, because a social
feature is the least defensible thing to admit into the tree as trusted in-process code.

## Alternatives rejected

- **Matrix as the `core.social` substrate.** §1. The decisive facts are the second permission model
  and the Postgres-plus-policy-server operational contract, not the SDK's size — though 27 MB with
  a mandatory 7.5 MB crypto wasm is itself a dependency nobody asked for.
- **XMPP.** Cheaper to host and the roster comes free in RFC 6121, but the modern group primitive
  (MIX) has been Experimental and unrevised since 2020 and needs cooperating code on both servers,
  and its encryption story (OMEMO) has been Experimental for eleven years. Adopting a standard whose
  load-bearing parts are unratified buys the compatibility argument and none of the compatibility.
- **ActivityPub.** Rejected on scope, not on quality: the spec has no presence, no real-time, no
  encryption and no authentication, so manifold would build every capability it wanted and inherit
  a publishing model it did not.
- **A `core.social` seat that "just" holds contacts and DM.** Rejected under roster restraint: the
  contacts half extends a seat that already owns principals and tokens, and the DM half is the
  notifications wave. A seat holding one table and one door, whose two halves belong to different
  owners, is a package created to justify a roadmap row.
- **DM on the event plane.** Rejected by ADR 0012 §5. Delivery to whoever happened to be subscribed
  is not a message system, and adding replay to get one would install the queue semantics that ADR
  rejected in its own Decision section.
- **A federated contact handshake (friend requests between instances).** Rejected as premature and
  as a moderation liability: an inbound state machine that strangers can start is a spam surface,
  and the local, asymmetric ledger in §3 supports every flow wave 3 actually has.

## Tensions with landed decisions

Flagged, not resolved. Each is a place where this proposal and a ratified decision disagree, or
where a ratified decision leaves a hole this proposal falls into.

- **T1 — `AXIOMS.md` §Roadmap says Matrix is the ratified leading candidate.** §1 contradicts it.
  Ratifying this ADR therefore obliges an amendment to the constitution's Social-layer bullet, by
  operator ratification, naming this ADR. This file does not make that edit (§Change control:
  axiom text changes by ratification only).
- **T2 — the roadmap promises a `core.social` plugin; §2 dissolves it.** Same amendment, same act.
  If the operator wants the seat, §3 and §4 are the contents it should have, and the amendment is
  smaller — but the two answers are mutually exclusive and only one can be the roadmap's.
- **T3 — workspace scope versus symmetric federation.** ADR 0013 §15 refuses container-scoped
  callers at workspace-graded doors; a wave-3 ticket is container-scoped by construction, and
  every door §3 proposes is workspace-graded. Wave 3 sidesteps this by having each side call its
  OWN instance's doors — `mintShare`/`revokeShare`/`listShares` on the host at container scope,
  `dialShare`/`openDial` on the guest at workspace scope — with only control frames crossing. That
  is a clean design and it means **a remote principal never calls a door on the far instance at
  all**. Every symmetric social act (B adds A as a contact because A added B; B messages A) would
  therefore need either a new instance-channel control frame per act, or a real
  `kind: "instance"` grant from ADR 0011. A2 says every capability is reachable identically by a
  local human, a remote human and an agent; under the landed design "remote human" can only mean
  "a principal of this instance whose lens is dialled elsewhere". Either that reading is recorded
  in CONTRACTS, or the grant has to arrive first. This is the sharpest constraint in this file and
  it should be decided before anything in §3 is built.
- **T4 — deferrals must be visible in-product** (`AXIOMS.md` §Change control). "manifold has no
  chat" is currently invisible: there is no refusal class, no placeholder, and no roster field that
  says so. If §2 is ratified, the visible form of the deferral needs naming — the honest candidate
  is that nothing is deferred at all, because no door was ever published; but then the roadmap row
  must stop promising one.
- **T5 — ADR 0012's own revisit trigger has fired.** It says to revisit "when cross-instance
  sharing (wave 3) needs events to cross a pipe to another manifold, which is the first case where
  'delivered to sockets subscribed at the time of emission' meets a network partition". Wave 3
  routes projection through the host's session channel rather than relaying events over the
  instance channel, which appears to discharge the trigger — but §4's durable-message tap makes
  `manifold://principal/<id>` a topic that a remote principal will want, and that is the partition
  case wearing different clothes. ADR 0014's authors own the first half; this file names the
  second.

## Ratification asks

Each is answerable yes/no, or by naming the amendment. Nothing in this file is normative until
they are answered.

- **R1.** Reject Matrix, XMPP and ActivityPub as the substrate of manifold's social layer, on the
  evidence in §"What each candidate actually costs"? (yes / no)
- **R2.** Demote Matrix from "ratified leading candidate" to "optional third-party bridge, never in
  the default distribution", and amend `AXIOMS.md` §Roadmap's Social-layer bullet accordingly in
  the same act? (yes / no)
- **R3.** Dissolve the `core.social` seat: no new core plugin, with the roadmap row's five
  nouns redistributed exactly as §2's table says? (yes / no — and if no, name the seat's contents,
  because §3 and §4 are the only two candidates this file found)
- **R4.** Accept the contacts ledger on `core.access` as scoped in §3 — three doors, `ctx.storage`,
  local and asymmetric, granting nothing, keyed by ADR 0014's `(origin, ref)` pair — including the
  door names `rememberContact` / `forgetContact` / `listContacts`, and including the ruling that
  all three sit behind `tokens:mint` because no read-only token capability exists? (yes / no /
  rename / add `tokens:read`)
- **R5.** Cross-origin admission: is holding a valid share secret sufficient to dial an instance
  (**A**, wave 3 as built), or does a host also require the dialling origin to be on a default-deny
  accept-list (**B**, this file's recommendation)? (A / B)
- **R6.** Is URL-origin identity accepted as manifold's federated identity — with its domain-loss
  failure mode written into `docs/CONTRACTS.md` §Identity as a known limit — or is a key-based
  instance identity owed before any social feature ships, as a change to ADR 0011's
  `kind: "instance"` grant row? (accept-origin / owe-a-key)
- **R7.** Does a spotlight from a principal on another origin need its own consent gate and its own
  refusal class, distinct from the local `manifold:ignore-spotlight` kill switch? (yes / no)
- **R8.** T3: does A2's "remote human" mean a principal of this instance dialling in — to be
  recorded in CONTRACTS — or must the `kind: "instance"` grant land before any workspace-graded
  social door is published? (record-in-contracts / owe-the-grant)
- **R9.** Chat, if it is ever wanted, waits for the Notifications wave and is built as §4 describes
  — durable row, action door, bodyless event tap — rather than as a plugin of its own? (yes / no)

## Revisit when

The Notifications wave is scheduled (then §4 stops being a deferral and becomes that wave's scope
question); or a second manifold instance is operated by somebody who is not the operator (then §5's
moderation inventory stops being a paragraph and becomes a requirement); or the permission
waterfall implements `kind: "instance"` grants (then T3 and R6 are decidable with the evaluator in
front of us rather than in prose).
