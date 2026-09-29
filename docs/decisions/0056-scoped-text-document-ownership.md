# 0056 — Text documents retain their authority homes

Date: 2026-09-29
Status: accepted

The living specification is [Scene sync](../CONTRACTS.md#scene-sync-yjs-crdt),
[placement and retained homes](../CONTRACTS.md#containers-placement-and-the-index), and
[element/tool authoring](../PLUGINS.md#6-contributions-with-corecanvasdraw-as-the-worked-example).
This records the full ownership transition required by
[ADR 0023 §6](0023-plugin-topology.md#6-text-is-its-own-noun-coretext-and-corecanvasnote)
and [#263](https://github.com/atyrode/manifold/issues/263), not evidence that operational
acceptance is complete. The editor dependency is recorded in [ADR 0055](0055-codemirror-editor.md).

## Problem

A legacy note stores a collaborative `Y.Text` inside a placed scene element. Moving that
whole element moves its text, and removing the last visual item can retire its composition.
Renaming that implementation does not make a separately owned document. Moving the body
into an unrelated new container is also wrong: an existing credential's immutable container
ceiling cannot be repointed by copying a grant or retargeting a visual reference.

The required split therefore separates content ownership from its visual representation
without moving the content's authority root. It must also preserve old retained revisions:
the server can recover an older valid snapshot when the newest stored bytes are corrupt.
Converting only the current projection would make recovery undo the ownership transition.

## Document identity and storage

A document has an immutable home container and an opaque id. A migrated document uses the
legacy `(containerId, elementId)` pair. Its body lives in the **same canonical room `Y.Doc`**,
but in a separately owned named collaborative-text collection, not inside its visual element.
`core.text` owns its namespace. The floor carries bounded names and records without knowing
that plugin's id or vocabulary. This is document-plane storage, not purgeable plugin KV or a
second SQLite text value.

The neutral `texts` root is a `Y.Map` of record maps, keyed by `namespace + ":" + id`.
Namespaces match `[A-Za-z0-9][A-Za-z0-9._-]*`, are at most 128 characters and contain no colon;
ids retain the existing scene id bound of 1–128 characters. Keys split at the first colon,
so opaque ids may contain colons. A record contains its namespace, id, one live `Y.Text`, and
optional `lastEditedBy`/`lastEditedAt` with the same meaning and bounds as element attribution.
Its plain-text projection is bounded by `MAX_TEXT_LENGTH` (20,000 UTF-16 units).
The existing ordinary document/update limits still apply; the new root is not an escape
from them. Certified migration overhead is accounted for separately below. Unsupported embedded
values are refused rather than silently stringified. Text
formatting attributes are preserved as Yjs data even when the plaintext editor does not
paint them.

Raw document updates receive the same receiving-boundary validation, accept-then-repair and
server-authored attribution as elements. Unknown namespaces remain data when their owner is
absent or disabled. The SDK publishes collection changes and document resets, and recognizes
local transactions made by a native Yjs binding rather than misclassifying every non-SDK
origin as remote. Each editor owns one collaborative text undo manager for its binding;
neither the existing scene undo history nor CodeMirror adds competing history. Local edits
and undo/redo honor the same text bound without truncation. Refusing an overlength history
operation leaves live text and history intact; focus/read-only changes do not retire a healthy
editor's history. Ordinary element-text APIs remain generic scene APIs, not native note storage.

A visual text reference carries an opaque `document` string whose codec is owned by
`core.text`: the JSON tuple `[homeContainerId, documentId]`. It replaces the legacy `text`
payload field one-for-one, preserving the existing flat-payload key budget. The standalone
route encodes that tuple as one path segment, so opaque identifiers cannot become path
separators or dot segments. A document remains discoverable in its home through the text
panel/route after its last visual reference is removed.

## Two owners, one editor

`core.text` is a standalone, first-party in-realm plugin with a panel, route, collaborative
storage and the tileable `text` element. Its open `text_home` container discipline serves new
standalone homes; this is contribution data, not a new floor enum. Home and element kinds
are distinct because the placement algebra resolves discipline traits before element traits:
a collection's inline homing and portal placement must not override an individual document's
`on_claim`/tileable behavior. Canvas is not a dependency of the text owner, and disabling canvas
cannot make retained text undiscoverable.

`core.canvas.note` lives under the canvas package, requires `core.canvas` and the peer
`core.text`, owns the `canvas_note` element and the canvas `text` tool, and borrows the text
renderer through the registered element outlet. It does not import its peer's implementation
or keep another editor/body. Its geometry and presentation remain its own data. Document
creation uses `core.text.create`, with the structured home as its `scenes:write` authority target.
The canvas child requests a body only (`reference: false`) before authoring its visual reference;
subsequent prose edits use the existing document channel. Its borrowed renderer requests intrinsic
editor height and measures its own wrapper, keeping geometry out of the shared editor. Cancelling
a late visual write does not silently delete an already committed independent body.

A contributed element may declare `representationOf` another element kind. The base kind
must exist, must not itself be a representation, and must be owned by the same plugin or a
required peer. The child declares this edge; the base owner never names a child. Placement
keeps an already accepted kind, otherwise selects the accepted canonical/unique alternate
representation. An ambiguous choice is refused, never resolved by registration order. Only
the representation changes: ids, payload, geometry, attribution and tile identity survive,
and the body remains in its authority home. The existing placement door and its source and
destination checks own this conversion. Browser and server placement decisions use the same
contribution data.

The native tool registry carries optional shortcut and point-authoring attachments keyed by
manifest-declared tool ids; it does not mount a tool component. A canvas owns pointer coordinates
and selection/focus mechanics, while the attachment receives the mounted client, container id,
principal, document point and cancellation signal. The child owns T and double-click activation;
the parent declares only its own select tool. A missing or disabled tool cannot author a hidden
note. This removes the parent's text factory/dispatch rather than importing its child.
The existing continuous draw gesture policy is not a second text authoring path and is not
replaced by this point API. [PLUGINS.md](../PLUGINS.md#6-contributions-with-corecanvasdraw-as-the-worked-example)
owns the executable attachment signatures.

## Native document access and authority

A panel or element must not construct a bearer-backed SDK client. The host exposes
`useDocumentAccess` above both workspace and plugin routes, using the existing SDK pool and
channel protocol. A matching same-identity mounted document of sufficient role can be borrowed;
foreign homes share bounded host-owned leases. Resting previews request spectator access and
an engaged editor requests occupant access. The host replaces its spectator before opening the
occupant, retains that engagement while consumers remain, and retires its client on final release
or identity/origin change. Borrowing never transfers ownership of the original client's lifetime.
The consumer receives a structural document port and explicit readiness/refusal, never a credential
or alternate transport constructor.

This native port is trusted in-realm access, not a new isolated-plugin API or a sandbox around a
mutable `Y.Text`. Native point attachments likewise receive an existing trusted room client.
Isolated consumers keep their bounded serialized host methods; raw Yjs handles, native point
contexts and bearers do not cross that boundary. In-realm installation remains code trust;
neither a structural TypeScript interface nor withholding one property confines such code.

Read admission remains `containers:read` at the home; edits remain `scenes:write` there.
Protocol 48's `sceneWriteAllowed` is the server-evaluated home write decision, refreshed through
full-state frames when grants change. `selfCaps()` remains the credential's raw ceiling:
a wildcard there is not effective authority. Native `canWrite` also requires open, occupant
access; spectator previews never acquire edit permission just by sharing a promoted entry.
A destination canvas does not grant access to a referenced foreign body. Inaccessible, missing
and disabled bodies have explicit noneditable outcomes. A valid credential refused at one
home receives channel-local refusal rather than closing unrelated admitted channels;
credential and protocol failures still close the connection.

Independent records are **retained content**, not visual census items. Every implicit
retirement/absorption path checks retained content before deleting a home or retargeting its
references. This does not change visual solo classification or idle-room eviction, which
flushes state rather than deleting it. Explicit authorized home deletion still deletes its
contents; surviving borrowed references report their missing home instead of manufacturing a
replacement or silently moving authority.

## Attended historical transition

Use the global backed-up schema migration runner and its ledger, not an ordinary plugin
migration callback, which cannot reach all scene revisions and is skipped for disabled plugins.
Preflight target namespace/state/reservation collisions and unsupported legacy shapes before
publishing changes. The complete transition commits transactionally; a refusal leaves the
source image intact and names the incompatible input.

For **each hash-valid, decodable retained revision**, independently:

1. Preserve container, epoch, revision, timestamp and unrelated maps.
2. Move the owned body under the stable home/id, preserving that revision's text delta/attributes
   and existing attribution. Same-epoch snapshots retain the original Y.Text/content Item
   identities and merge behavior, not merely the same string or a freshly reconstructed delta.
   The closed-snapshot transformation may use the pinned Yjs codec, never rewrite a live room
   graph or introduce a second live synchronization implementation. New record-container and
   constant metadata identities must be stable within the lineage and collision-free against
   every retained source client id. A legacy plain string needs a stable live-Y.Text conversion;
   no synthetic Item id may name different content or parents across revisions. Do not substitute
   the latest revision's text into older snapshots.
3. Keep element/tile ids and presentation data. Canvas text becomes `canvas_note`; a
   composition's text remains the `text` representation owned by `core.text`. Replace only
   its inline body with the owned document reference.
4. Re-encode and rehash the converted revision. Preserve corrupt rows as corrupt evidence,
   so an older valid converted revision remains the recovery fallback.

The format adds representation metadata, so a previously valid near-limit revision can grow.
Do not turn that into a read-only or unjoinable document, discard history, or raise ordinary
client-content limits. Migration records the maximum positive encoded-byte delta across each
home/epoch's retained revisions as fixed server-owned `scene_doc_capacity`. The ordinary 12 MiB
document allowance gains only that certified credit. Updates cannot mint more, other epochs
cannot inherit it, and deleting the last retained lineage row retires it. This finite allowance
is fungible after later GC; it is not an ongoing accounting of individual migration structs.
Sanitized preview seeds retain these three document-format columns alongside the snapshots,
never arbitrary columns or authority from the source database.

Full-state egress accounts for base64 expansion separately: the document gets
`4 * ceil((12 MiB + credit) / 3)` bytes and JSON/routing/attendance/terminal metadata gets a
4 MiB envelope. This is not permission for unbounded populations: oversized envelopes still
refuse admission. Ordinary frames and client ingress retain the 16 MiB ceiling. Conversion
streams revisions with stable identity indexes instead of keeping every decoded snapshot and
output blob alive. Disposable near-limit proof must include real state delivery and edits;
bounded history retention alone does not establish an absolute process-memory ceiling.

Preserve existing element/container references and their grants. Reconcile persisted plugin
identity references and ownership reservations explicitly, including the transfer of `text`
from `core.notes` and collision-free reservation of `canvas_note`. Preserve opaque legacy
plugin storage and migration/attribution facts; do not erase them because current notes do
not ordinarily use private KV.

Administrative enablement has no hidden derived cascade. `core.text` inherits the legacy
notes state and attribution. The new child is on only when both legacy notes and canvas are
on; when it must be off, preserve the attribution of the existing state that requires that
outcome rather than inventing a fresh actor/time. A disabled text/canvas combination must not
be re-enabled by migration, nor make the independently enabled text plugin depend on canvas.

Protocol 48 fences old session clients from replaying the inline-body representation. Keep
historical epoch identities; do not claim that an epoch rewrite is identity preservation.
The machine wire is unchanged, so compatible agent versions remain admitted. A compatible
old binary plus the **complete pre-version backup** is the rollback path; starting an old
binary against the migrated image is not rollback. Post-transition edits are not silently
claimed to exist in an earlier backup.

No persistent-instance migration or production/fleet operation is exercised by the disposable
migration proof. Operational activation remains subject to its own applicable authority.

## Foundation admission

These are bounded extensions of existing pillars, not a new content-owning floor plugin:

- **Bootstrap:** a plugin cannot implement authoritative room repair, multiplexed channel
  ownership, or placement admission by keeping its own browser state. They must exist before
  its renderer/action can use them.
- **Neutrality:** namespace/id/text records, releasable document access, point-tool attachments
  and declared representations name no favorite plugin, editor, canvas-note schema or body
  policy. CodeMirror, document codecs, text actions and note presentation stay above the floor.
- **Arbitration:** the server arbitrates concurrent document edits and authority; the host
  arbitrates shared transport lifetime; assembly/placement arbitrates competing declarations
  and source/destination acceptance. None is an alternate text implementation.

Update the scene-sync, web-host and placement inventory/contracts with their implementation.
The immutable credential ceiling, four planes and plugin import directions are unchanged.

## Required proof

Prove the receiving boundary with raw updates, local/remote/undo provenance, convergence and
reset behavior. Exercise an inaccessible foreign home without interrupting an admitted room,
home-effective write denial despite a wildcard raw ceiling, promotion and final-release cleanup,
and bounded local undo in the presence of peer edits. On disposable historical data, observe
identities, references, scoped grants, every disabled combination, attribution,
reservations/collisions, all valid retained revisions, corruption fallback, restart and
compatible-binary rollback. Merge converted older/newer snapshots with concurrent edits to the
retained legacy text identity and compare with the equivalent legacy merge; equal initial
strings do not discharge this obligation. Finally exercise actual standalone and canvas editing,
multiplayer/reconnect behavior, placement between representations and manager nesting/enablement,
with visual inspection. None of those outcomes is established merely by this decision record
or a passing typecheck.
