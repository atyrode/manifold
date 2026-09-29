# 0056 — Text documents retain their authority homes

Date: 2026-09-29
Status: accepted

The living specification is [Scene sync](../CONTRACTS.md#scene-sync-yjs-crdt) and
[plugin topology](../PLUGINS.md). This implements the full ownership transition in
[ADR 0023 §6](0023-plugin-topology.md#6-text-is-its-own-noun-coretext-and-corecanvasnote)
and [#263](https://github.com/atyrode/manifold/issues/263). The editor dependency is separately
recorded in [ADR 0055](0055-codemirror-editor.md).

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
Namespaces are nonempty ASCII identifier strings of at most 128 characters and contain no
colon; ids retain the existing scene id bound of 1–128 characters. A record contains its
namespace, id, one live `Y.Text`, and optional `lastEditedBy`/`lastEditedAt` with the same
meaning and bounds as element attribution. Its plain text is bounded by `MAX_TEXT_LENGTH`.
The existing aggregate document/update limits still apply; the new root is not an escape
from them. Unsupported embedded values are refused rather than silently stringified. Text
formatting attributes are preserved as Yjs data even when the plaintext editor does not
paint them.

Raw document updates receive the same receiving-boundary validation, accept-then-repair and
server-authored attribution as elements. Unknown namespaces remain data when their owner is
absent or disabled. The SDK publishes collection changes and document resets, and recognizes
local transactions made by a native Yjs binding rather than misclassifying every non-SDK
origin as remote. Each editor owns its collaborative text undo manager; the existing scene
undo history does not become a second competing editor history.

A visual text reference carries an opaque `document` string whose codec is owned by
`core.text`: the JSON tuple `[homeContainerId, documentId]`. It replaces the legacy `text`
payload field one-for-one, preserving the existing flat-payload key budget. The standalone
route encodes that tuple as one path segment, so opaque identifiers cannot become path
separators or dot segments. A document remains discoverable in its home through the text
panel/route after its last visual reference is removed.

## Two owners, one editor

`core.text` is a standalone, first-party in-realm plugin with a panel, route, collaborative
storage and the tileable `text` element. It can also declare the open `text` container
discipline for new standalone homes; a discipline is contribution data, not a new floor enum.

`core.canvas.note` lives under the canvas package, requires `core.canvas` and the peer
`core.text`, owns the `canvas_note` element and the canvas `text` tool, and borrows the text
renderer through the registered element outlet. It does not import its peer's implementation
or keep another editor/body. Its geometry and presentation remain its own data. Document
creation is opened through the text owner's declared action, with target-specific authority;
subsequent prose edits use the existing document channel.

A contributed element may declare `representationOf` another element kind. The base kind
must exist, must not itself be a representation, and must be owned by the same plugin or a
required peer. The child declares this edge; the base owner never names a child. Placement
keeps an already accepted kind, otherwise selects the accepted canonical/unique alternate
representation. An ambiguous choice is refused, never resolved by registration order. Only
the representation changes: ids, payload, geometry, attribution and tile identity survive,
and the body remains in its authority home. The existing placement door and its source and
destination checks own this conversion. Browser and server placement decisions use the same
contribution data.

The native tool registry gains an optional point-authoring attachment. A canvas owns pointer
coordinates and selection/focus mechanics; the contributed tool owns what it authors, its
shortcut and optional double-click activation. A missing or disabled tool cannot author a
hidden note. This removes the parent's text factory/dispatch rather than importing its child.
The existing draw gesture implementation is not a second text authoring path and is not
refactored by this change.

## Native document access and authority

A panel or element must not construct a bearer-backed SDK client. The host exposes a bounded,
releasable native document-access port, using the existing SDK, connection pool and channel
protocol. A matching mounted document can be borrowed directly. Foreign homes share host-owned
leases, which are retired when their consumers release them. Resting foreign previews are
spectators; an engaged editor uses an occupant channel and remains subject to its home grants.
The host owns any promotion and client replacement; the plugin receives no credential or
alternate transport constructor.

Read admission remains `containers:read` at the home; edits remain `scenes:write` there.
A destination canvas does not grant access to a referenced foreign body. Inaccessible, missing
and disabled bodies have explicit noneditable outcomes. A valid credential refused at one
home must receive the existing channel-local refusal rather than closing unrelated admitted
channels; credential and protocol failures still close the connection.

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
2. Create the owned body under the stable home/id, preserving its own text delta/attributes
   and existing attribution. A legacy plain string becomes a live `Y.Text` without changing
   its value. Do not substitute the latest revision's text into older snapshots.
3. Keep element/tile ids and presentation data. Canvas text becomes `canvas_note`; a
   composition's text remains the `text` representation owned by `core.text`. Replace only
   its inline body with the owned document reference.
4. Re-encode and rehash the converted revision. Preserve corrupt rows as corrupt evidence,
   so an older valid converted revision remains the recovery fallback.

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
reset behavior. Exercise an inaccessible foreign home without interrupting an admitted room.
On disposable historical data, observe identities, references, scoped grants, every disabled
combination, attribution, reservations/collisions, all valid retained revisions, corruption
fallback, restart and compatible-binary rollback. Finally exercise actual standalone and
canvas editing, multiplayer/reconnect behavior, placement between representations and manager
nesting/enablement, with visual inspection. None of those outcomes is established merely by
this decision record or a passing typecheck.
