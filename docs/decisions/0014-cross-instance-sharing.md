# 0014 — Cross-instance sharing: the instance channel, shares, and remote principals

Date: 2026-08-31
Status: accepted
Ratified: ratified 2026-08-31 (axiom A4), **landing in wave 3** (#74)

## Context

A4 says composition is projection: every node has one owner, one home and one canonical
`manifold://` address, and viewing any node is always the same three steps — resolve the
reference, open a pipe with a grant, project it. The axiom then states the part this wave owes:
"A **share** to another manifold instance is that same reference-and-pipe shape over the
network — the machine channel (a remote process dialing in with a token, version-negotiated) is
the shipped precedent it generalizes." A5 says what a share IS in authority terms: "a minted
token bound to a subtree grant, portable because it is data."

Wave 1 reserved the structural room and wrote nothing: the SDK's channel pool is conceptually
keyed by `(origin, containerId)` with origin fixed to this instance, and `docs/CONTRACTS.md`
§Identity carries a prose note that principals reserve a future `origin`. Wave 2 built the event
plane the roadmap said this wave would ride. Nothing else exists.

The danger in this wave is specific, and it is not the transport. It is that "another instance"
is the most inviting excuse in the codebase to build a second of everything: a second sync path
(a relay that mirrors the host's document into a local room), a second renderer (a "remote
container" view), a second authority model (share ACLs beside caps), a second liveness scheme (a
federation heartbeat beside the machine channel's), and a second address system (a URL beside
`manifold://`). Each of those is invariant 14 violated once, and the second authority model is
A5 violated as well. The design below is mostly a set of refusals to build those, and the parts
that remain are small because of it.

One more constraint shapes it. `AXIOMS.md` §The portable lens already says the client must not
assume the server it talks to is the origin it was served from — "the instance is configurable,
because a lens that can only look at its own birthplace is not a lens." A lens pointed at a
second instance is therefore a rule already on the books, not a new licence this ADR asks for.

## Decision

### 1. Two planes, and the instance channel is the control one

Cross-instance sharing is **two connections with two jobs**, and conflating them is what produces
the relay:

- **Control — the instance channel (`/ws/instance`).** The GUEST instance dials OUT to the HOST
  instance, long-lived, version-negotiated, liveness-pinged, authenticated by a share token.
  This is the machine channel's discipline generalized, and it carries no scene bytes, no
  document updates, no presence and no terminal output. Ever. It carries three things: the
  guest's identity claim, the host's description of the share, and per-principal ticket
  issuance.
- **Projection — the host's existing `/ws/session`.** The guest user's own lens dials the HOST
  directly with a ticket and joins the shared container's room as an ordinary participant. No
  proxy, no relay, no mirrored document.

The consequence is the whole point: from the host's side a remote viewer is another authenticated
principal in the same `Room`, so scene sync, attendance, presence, cursors, terminals, placement
and every action door are byte-for-byte the machinery a local viewer uses. There is no
"remote" branch anywhere downstream, which is invariant 11 applied across instances (§4) and
invariant 14 kept intact.

### 2. A share is a token bound to a node, minted for a named origin

A **share** is A5's sentence made concrete: a row naming a node (`manifold://container/<id>`),
a capability set, and the **origin** of the instance it was minted for, plus a bearer secret
handed to the caller exactly once. It is hashed at rest exactly like every other token
(invariant 5), never logged, never returned by a list door.

**The guest origin is named at mint; a share is not an open bearer link.** Three reasons, in
increasing order of force. A4 says a share is "to another manifold instance", so it is inherently
addressed. Invariant 11 requires origin to be trustworthy DATA — nothing downstream of
arbitration may branch on it, so it must be a fact the host recorded rather than a string the
dialer claimed. And it gives the handshake a real check instead of a decorative one: a `hello`
whose declared origin is not the share's recorded origin is refused (4401 `origin mismatch`).
The cost is that sharing to an instance whose public URL you do not yet know needs an invite
flow, which `AXIOMS.md` §Roadmap already parks in the social wave.

**No expiry this wave.** A share has `createdAt` and a nullable `revokedAt` and nothing else
temporal. Revocation is the mechanism, and it is a live one (§5); an expiry field would be a
second, weaker one, and the wave that wants leases can add it as an additive-optional field
without moving anything here.

**One dial per share.** The token authenticates one share, so the instance channel needs no
share id in its frames and no catalogue push: a second share to the same guest is a second token
and a second dial. The alternative — one long-lived pairing between two instances carrying a
catalogue — requires an instance-level principal and a pairing handshake, which is genuinely new
authority semantics and therefore ADR 0011's and the social wave's business, not this one's.

**The host hashes; the guest keeps the raw secret, and the asymmetry is the design.** A host only
ever VERIFIES a presented secret, which a hash does (`shares.hash`); a guest must PRESENT one,
which a hash cannot (`dials.secret`). That is the trust boundary the auto-spawned agent's raw
`<data>/agent.token` already sits on, stated here so a reader does not file the clear column as a
lapse.

### 3. Tickets: how a guest user reaches the host without holding the share secret

The share secret belongs to the guest INSTANCE, exactly as a machine token belongs to the agent
daemon. It is never handed to a guest user, because a bearer secret in a browser is a share that
cannot be narrowed and cannot be attributed.

Instead, opening a shared node is the A4 three-step taken literally, one step per party:

1. A guest principal calls **`core.access.openDial`** on its OWN instance. That door decides
   whether this principal may use this dial — the guest's own authority question, answered by the
   guest.
2. The guest instance sends **`ticket_request`** over the instance channel, carrying its local
   principal as data.
3. The host **mints an ordinary attenuated token** through the existing ladder: caps = the
   share's caps, container scope = the shared container, principal = a host-side mirror of the
   guest's principal stamped with `origin`. It answers **`ticket`**.

The guest's lens then dials the host's session endpoint with that ticket. Every property that
matters falls out of the ticket being a REAL token rather than a special credential: attenuation
is `mintToken`'s existing ladder, cap intersection at the host's doors is the ordinary one,
revocation is the ordinary fence, and the audit trail names a principal rather than "the share".

The host derives its own id for the mirror principal and never adopts the foreign one: two
instances' id spaces are independent, and trusting a claimed id would let a guest impersonate a
host-local principal.

The host keeps one mirror principal per `(share, guest principal)` — the `share_tickets` table is
a DEDUPE MAP, not a second identity system. Its `principal_id` is an ordinary principal holding an
ordinary token, which is exactly why the host's doors, its revocation fence and its attendance
roster all work on a remote guest with no special case anywhere; the map exists so that the same
guest user returning tomorrow is the same principal in the attendance roster rather than a new
face.

### 4. `origin` is data, on the principal, once

`Principal` gains `origin?: string` — **additive-optional, absent ≡ local**, which reproduces
pre-v18 semantics by omission rather than by a default anybody has to remember. Its value is an
instance's normalized public base URL (absolute `http(s)`, lowercase scheme and host, no trailing
slash, ≤256 chars); `normalizeInstanceOrigin()` in `packages/protocol/src/instance.ts` is the one
normalizer and both ends use it.

It rides the principal and nothing else. Attendance carries it because `PresenceState.principal`
IS a `Principal`; the ticket carries it because the ticket carries a principal. No frame grows a
second origin field, because a fact stored twice is a fact that disagrees with itself.

**Invariant 11 across instances:** origin is DATA, never a branch. Nothing downstream of
arbitration may ask whether a peer is remote — no remote-flavored cursor, no "(remote)" suffix
baked into a renderer, no second attendance row shape. A client MAY render origin the way it
renders a principal's name and color, which is presentation of a datum, not a branch on it.

### 5. Revocation severs live, with no new mechanism

Revoking a share revokes every ticket principal minted under it. `auth.onRevoked` already fences
live sockets (`4403 revoked`) — the session gateway and the machine gateway both subscribe to it
today — so the guest's live projections close through the path that already exists. The instance
channel adds one more subscriber to that same fanout and closes the dial with the same code.

This is the wave's convergence-gate-class claim and it is what the two-instance e2e proves: a
container of A rendering through B's session surface, and a revoke at A tearing it down live.

### 6. Addressing: no authority in `manifold://` this wave

A `manifold://` URI stays an address inside ONE instance's addressing space. A cross-instance
reference is the PAIR `{ origin, ref }`, carried by the share record, the dial record and the
`welcome` frame.

The tempting alternative — `manifold://<origin>/container/<id>` — is deferred deliberately rather
than overlooked. Topics are `ManifoldRef`s (ADR 0012), `topicMatches` compares refs structurally,
`/api/resolve` parses them, and the URI module's bijection is pinned by test; giving the grammar
an authority component changes every one of those comparisons in a wave whose subject is
something else. The pair form costs one field and forecloses nothing.

### 7. One liveness scheme for every dialed pipe

The machine channel's constants are renamed, not duplicated: `MACHINE_PING_INTERVAL_MS` →
`DIAL_PING_INTERVAL_MS` and `AGENT_LIVENESS_TIMEOUT_MS` → `DIAL_LIVENESS_TIMEOUT_MS`, with every
caller migrated in the same commit (no aliases — D13). A **dial** is the canon word for a
long-lived outbound pipe from a process to an instance; the machine channel and the instance
channel are both dials, and they now share one ping cadence, one silence deadline and one
close-code vocabulary: 4401 unauthorized (including origin mismatch) · 4403 revoked · 4409
protocol version · 4002 malformed, non-hello first frame or duplicate hello · 4008 liveness
timeout · 4001 superseded · 1001 shutdown.

Naming the constants after ONE of the two occupants was the accident; the second occupant is what
exposed it.

### 8. Resume rides the hello

There is no `resume` frame. The guest's `hello` advertises the ticket principals it believes are
live, and `welcome` answers with the subset that still is — precisely the shape of the machine
`hello` advertising retained terminals and `welcome` acknowledging them. The guest drops
projections whose credential died while it was disconnected instead of waiting for the host to
refuse them one socket at a time.

A separate resume frame would be a second reconnection mechanism for a channel that already has
one, and the machine channel spent a wave proving that reconnection state belongs in the
handshake that re-establishes it.

### 9. The doors, and where they live

`core.access` extends its existing action family — no new roster seat. A share is a token bound
to a node, so the cap that already means "hands authority out" is the cap: **no new capability**.

| Action                    | Caps               | Scope     | What it is                                              |
| ------------------------- | ------------------ | --------- | ------------------------------------------------------- |
| `core.access.mintShare`   | `tokens:mint`      | container | mints a share for a named origin; raw token once        |
| `core.access.revokeShare` | `tokens:mint`      | container | revokes the share and every ticket under it (`cleanup`) |
| `core.access.listShares`  | `tokens:mint`      | container | both directions: `{ shares, dials }`                    |
| `core.access.dialShare`   | `containers:write` | workspace | accepts a share token and starts the guest dial         |
| `core.access.openDial`    | `containers:read`  | workspace | the caller's ticket + address for a dialed share        |

`revokeShare` is `cleanup: true` for the reason `revoke` already is (ADR 0013 §9): taking
authority back is the verb somebody reaches for when a secret has leaked, and a disabled plugin
must never be the reason a compromised share stayed alive. Its verb is removal, so S10's closed
verb list admits it.

`listShares` answers both collections through one door because the concept is "the cross-instance
relationships this instance has". Two list doors would be two answers to one question.

**`dialShare` BLOCKS on the handshake.** A `Dial` names the node and the capability set the
host reported, and those are facts only the `welcome` carries, so a row cannot honestly exist
before the far side answers. The door therefore waits (ten seconds, the machine channel's hello
deadline) and refuses `conflict` "host did not answer" otherwise; an unanswered attempt is
DELETED rather than marked revoked, because nothing was granted and there is no authority whose
end to record. Answering optimistically would turn a bad token, a wrong origin, an
already-revoked share and an unreachable host into one permanently-offline zombie row — a
deferral only a log reader can discover, which `AXIOMS.md` §Change control forbids.

### 9a. The dial's news is three declared events

`core.access` declares `dial_online`, `dial_offline` and `dial_revoked` in
`contributes.events`, and the FLOOR emits all three on `manifold://plugin/core.access`.

That split is `machine_online`'s ruling applied unchanged (ADR 0012 §1: the engine emits, the
plugin declares). A long-lived outbound socket coming up or going down is not the commit point
of any action — no door was called, so there is no door to emit at — while the VOCABULARY
belongs to the plugin whose doors create and destroy the relationship. `dial_revoked` is the one
a guest acts on hardest: it is the moment a projection stopped being legal, arriving with
nobody at this instance having done anything.

The share doors' own emissions need no declaration here: an action's commit point is emitted by
the dispatcher, staged behind the handler's success, which is the mechanism ADR 0012 already
owns.

### 10. What this wave does NOT build

Stated so that absence reads as a ruling. No share UI (the manifests carry the deferral marker
`share UI: deferred, door-only`, the convention `core.access` introduced). No per-principal
narrowing INSIDE a share — every principal the guest's `openDial` admits gets the share's full
caps, because narrowing per remote principal is a grant question and grants are ADR 0011. No
instance-level pairing, no invite flow, no discovery. No fork ("detach as copy"), which A4
reserves explicitly and which a share must never imply.

## Dependency verdict (AGENTS invariant 8 and its converse, D14)

The pattern here is "a long-lived authenticated WebSocket client with backoff, liveness and a
request/response correlation map". Candidates evaluated by name:

- **`reconnecting-websocket`** (~2kB) — supplies reconnection with backoff and nothing else. It
  would replace `reconnectDelayMs` plus the dozen lines around it, and it would NOT supply the
  parts that are actually hard here (hello/welcome handshake state, ticket correlation, the
  4403-means-stop rule). It also owns the socket, which collides with invariant 3: the repo has
  exactly one WebSocket state machine per wire and the SDK owns it.
- **`ws`** — a server-side WebSocket implementation. Bun serves and dials WebSockets natively;
  adding it would be a second transport under the one the tree already uses.
- **`yjs` providers (`y-websocket`)** — the shape a relay design would have reached for, and the
  clearest evidence for §1: adopting it would install a second sync path beside the room's own,
  which is exactly what this ADR refuses to build. Rejected on architecture, not on size.

**Verdict: no new dependency.** The instance dial is ~200 lines of state machine that reuses
`reconnectDelayMs`, the frame-classification discipline `machine-ws.ts` already established, and
the liveness constants §7 renames. Everything a library would have saved is the part that is
already written; everything it would not have saved is the part that is manifold-specific.

## Protocol impact — the invariant-10 verdict

`PROTOCOL_VERSION` 17 → **18**, shipped in a dedicated `protocol:` commit.

**`MACHINE_PROTOCOL_COMPAT_VERSIONS = {16, 17, 18}` — v18 is ADDED, and no fleet restart is
owed.** The agent-facing wire is byte-identical: `AgentMessage` and `ServerToAgentMessage` gain,
lose and rename no field. An agent never sees a `Principal`, so the one additive-optional session
change (`origin`) is invisible to it, and the liveness rename (§7) changes two identifiers and
zero bytes — the cadence, the deadline and every close code are the values they were. Invariant
10's first clause applies verbatim: a bump that leaves the agent wire identical adds the version
rather than resetting the set.

**`INSTANCE_PROTOCOL_COMPAT_VERSIONS = {18}`** is a SEPARATE acceptance set for a separate wire.
A guest instance is long-lived in the same way an agent is, so its wire needs the same
version-negotiation discipline; but it is not the agent's wire, and pointing the instance channel
at the agent's set would make an agent-wire reset silently lock out federated instances that
never spoke that wire. The set starts at the version that introduces it.

Session wire: additive-optional `Principal.origin` (absent ≡ local). Session joins remain
strictly current, so nothing negotiates it.

## Alternatives rejected

- **Relay the host's room through the guest instance.** The guest server joins the host as a
  client and re-projects into a local room. It reads as "the guest owns its users' connections",
  and it is a second sync path: two `Room`s for one node, two epochs, two rev counters, presence
  identity that has to be rewritten in flight, and terminal output crossing two authority
  boundaries. Invariant 14 forbids it, A4 §"never absorbs" forbids it, and the portable lens rule
  makes it unnecessary.
- **Hand the guest's users the share secret.** Simplest possible design, and it fails the moment
  you ask who used the share: a bearer secret in N browsers cannot be attributed, cannot be
  narrowed and cannot be revoked per user. Tickets cost one round trip on the channel that is
  open anyway.
- **A `share:read`/`share:manage` capability pair.** Rejected on A5: a share is a token bound to
  a node, so its authority is the cap set it carries, and a capability whose meaning is "may
  create authority" already exists (`tokens:mint`). A new cap would be a second answer to
  "who may delegate".
- **A `core.sharing` plugin.** Roster restraint (AGENTS §Conventions) and the litmus: sharing is
  minting and revoking authority, which is what `core.access` already is. A second seat would
  split one concept across two manifests.
- **Origin as an opaque instance id or a public key.** Attractive for a future where instances
  authenticate each other cryptographically, and wrong today: the guest must dial a URL anyway,
  so a URL is the identity that is already load-bearing, and an opaque id would need a directory
  to resolve it. Key-based instance identity is the social wave's question.
- **Federate over Matrix.** Already ratified as rejected-as-foundation (`AXIOMS.md` §Roadmap): it
  would install a second room model, a second event model and a second permission model beside
  manifold's own. It stays the leading candidate for `core.social`, where share-INVITATION
  signaling belongs.

## Decisions taken under delegated authority (operator review owed)

The operator was asleep for this wave; the plan underdetermined these, and each was taken
conservatively — cheapest to reverse, smallest surface, no new authority semantics. Every one is
a field or a row, not an architecture.

1. **No share expiry.** Revocation only (§2). Reversible as an additive-optional field.
2. **One dial per share** rather than one pairing per origin (§2). The alternative needs
   instance-level identity.
3. **Origin is bound at mint**, not claimed at dial (§2) — a share is addressed, not a bearer
   link.
4. **Origin is a normalized base URL**, not an opaque id or a key (§4).
5. **No authority component in `manifold://`** (§6); the cross-instance reference is
   `{ origin, ref }`.
6. **Five doors, one job each** (§9), with `listShares` answering both directions.
7. **`containers:write` to accept a dial, `containers:read` to open one** (§9) — the closest
   existing caps to "changes what this workspace shows" and "reads a container".
8. **Every principal the guest admits gets the share's full caps** (§10); per-principal narrowing
   is ADR 0011.
9. **The liveness constants were renamed rather than duplicated** (§7), which touches the machine
   channel and the agent in a wave that is not about them.
10. **The instance dial's cost is declared in prose under `REGISTRY.md` §Budgets rather than as a
    `network` row**: that table measures a browser at idle and its rows are joined to the
    browser's feed vocabulary, while a dial is a server-to-server liveness link costing one
    ping/pong pair per `DIAL_PING_INTERVAL_MS` per dial. Declaring it dishonestly as a browser row
    would have broken the join check that keeps the table honest.
11. **`dialShare` blocks on the handshake** and deletes an unanswered attempt (§9) rather than
    writing a row that names nothing yet.
12. **The dial's three lifecycle events are emitted by the floor and declared by
    `core.access`** (§9a), which is `machine_online`'s split rather than a new one.
13. **A path-mounted instance (`https://example.com/manifold`) is refused as an origin** rather
    than silently truncated to its host (§4); the honest fix is a host name of its own.
14. **No new environment variable.** An instance's origin is `MANIFOLD_PUBLIC_URL`'s origin and
    nothing else: a `MANIFOLD_INSTANCE_ORIGIN` beside it would be a second door onto how this
    instance is addressed, in the one place it would be most tempting to fudge. There is also no
    kill switch for dialling — disabling `core.access` already refuses new dials while live ones
    survive, which is D12's "creation dies, cleanup survives" applying exactly as written.

## Revisit when

- **ADR 0011 lands.** Share and ticket both become grant rows: the share is a subtree grant at
  its node, the ticket is a grant reference, and `openDial`'s "may this principal use this dial"
  becomes an evaluator call instead of a cap check. This ADR's §3 is written so that swap is one
  call surface.
- **A second share to one origin becomes common.** N dials for N shares is honest and cheap at
  small N; at large N it is a socket per grant, and the pairing design (§2) becomes worth its
  authority cost.
- **Something needs to address a remote node in a URI** — a deep link, a topic, a spotlight
  crossing instances. That is the trigger for §6, and it should arrive as one grammar change with
  every comparison audited, not as a special case in one consumer.
- **A guest wants to project a node it cannot reach directly** (host behind a NAT the guest's
  browser cannot cross). That is the only honest argument for a relay, and it must be answered
  with a dated ADR that says how it avoids being a second sync path — most likely by relaying
  BYTES for one socket rather than by mirroring a document.
