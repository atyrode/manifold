# Proposed shared-file contract

**Status: design proposal, not adopted policy or an implementation claim.** This is the full
A+B+C design deliverable for [#370](https://github.com/atyrode/manifold/issues/370): durable shared
files, canvas images, and explicit machine delivery/download. It changes no runtime, grant,
protocol, default roster, foundation pillar, backup, or deployment. All limits below are proposed
product limits, not measurements. All acceptance scenarios are future implementation proof.

The [axioms](../../AXIOMS.md), [CONTRACTS](../CONTRACTS.md), [PLUGINS](../PLUGINS.md), and
[registry](../../REGISTRY.md) remain authoritative. Adoption requires their coordinated updates
and the missing mechanisms named below; merging this proposal does not authorize those changes.
Native terminal clipboard support remains independent and must not wait for this design.

## Scope and present substrate

A **file** is one immutable completed byte sequence with one authoritative logical record, owner,
home instance and canonical reference. A canvas image is a reference to a file, not another file
store. Machine placement creates an independent copy; a successful upload proves neither remote
placement nor application consumption. Renaming display metadata does not change content or URI;
replacing content creates a new file and an explicit reference edit, not silent mutation.

Source grounding is main `155bf503806750645ab66f726f301b0fbea282f1`, not runtime proof:

| Existing contract                                                                                                 | What it supplies                                                                                                    | What it does not supply                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Plugin database](../PLUGINS.md#your-tables-ctxdatabase), [exported types](../../packages/plugin/src/database.ts) | Engine-owned per-plugin SQLite, BLOB parameters, bounded calls, atomic small batches, retention and purge           | File records, end-user file permissions, upload transport, reservation accounting or arbitrary filesystem access       |
| [Plugin streams](../CONTRACTS.md#plugin-owned-continuous-streams)                                                 | Bounded server-to-client metadata, live authority checks, explicit gap/reset                                        | Client byte upload, durable file bodies or a replacement for authorized private job-output reads                       |
| [Grant waterfall](../CONTRACTS.md#authority-is-a-waterfall-of-grants-adr-0011-shipped)                            | One grant store/evaluator, plugin-namespaced capabilities, declared action target requirements                      | A file reference kind or a delegated file-sharing policy; existing root-only grant administration must not be bypassed |
| [Governed machine jobs](../CONTRACTS.md#governed-machine-jobs)                                                    | Proved owner identity, reviewed revision-bound locations/consent, held-descriptor confinement, sealed output paging | A general upload, arbitrary machine-file read or cross-machine input binding                                           |
| [Native clipboard](../CONTRACTS.md#native-terminal-clipboard)                                                     | Explicit, temporary MIME transfer to a consenting application                                                       | Retained/shared files, a remote filesystem service or automatic saving                                                 |
| [Full-state recovery](../SELF-HOST.md#backup) and [implementation](../../scripts/full-state-recovery.ts)          | Authenticated encrypted inventory including plugin databases; consistent individual SQLite images                   | An unlimited archive or plugin-data protection from ordinary Litestream, which replicates only `manifold.db`           |

In particular, the existing plugin database authoring text describes structured rows and directs
large document-plane content elsewhere. BLOB parameter support is not permission to declare a
shipped object service. Adoption must explicitly document bounded, action-owned immutable chunk
rows as a database use case, without moving collaborative text or scene edits out of their plane.
No implementation may infer that permission from this proposal alone.

## Ownership and addressing proposal

Propose one opt-in file product plugin, provisionally `core.files`, owning records, transfers,
sharing UI, the file library and its machine half. A file works without any canvas. Do not put
file policy in the shell, `core.terminals`, the general index, installation uploads or job-output
storage. Those owners cannot satisfy independent file retention without acquiring a second
responsibility. The seat justification is the requested independent durable-file capability; it
is not an additional default-on roster entry or foundation pillar.

A small declared child, provisionally `core.files.images`, depends on both the file owner and
`core.canvas`, and owns image elements, rendering and canvas ingestion. Disabling canvas must
not disable independent file access. Dependency ordering, contribution collisions and disabled
placeholders use the existing assembly, not conditional imports or a second renderer. Exact IDs
are proposed, not reserved in the registry by a document.

Propose the reference kind `file` and canonical `manifold://file/<opaque-id>`, directly under the
workspace root. The home instance qualifies foreign references through the existing origin/ref
model; no second local alias or content-address URL is canonical. File identity does not depend
on a canvas, owner display name, filename or digest. The stored owner is attribution, not an ACL
shortcut; all reads and mutations use the waterfall at the canonical node. General cross-instance
file transfer is not implied by today's container-only sharing; a foreign projection must refuse
until the same authenticated byte contract is supported at its home, never fetch a public URL.

`ManifoldRefSchema`, parse/format/containment, resolver responses, action target schemas,
capability targets, SDK consumers and every exhaustive switch must migrate together. Register the
new kind/lexicon, element ownership and eventual checks with implementation, not ahead of it.
This proposal does not implement the deferred general seat/cursor model in
[Reference nodes](../CONTRACTS.md#reference-nodes).

### Authority and default sharing

- **Private by default:** no class-wide read grant is created by upload or clipboard capture.
  The creator gets explicit node-scoped file rights at publication. Ordinary canvas membership,
  knowledge of an ID/digest, a scene reference, machine ownership and installation are not read
  authority. Existing administrator powers remain as defined by the waterfall; “private” is not
  encryption from the hub operator.
- Propose plugin-namespaced `core.files:create`, `read`, `delete` and `share` capabilities, fully
  qualified under the plugin ID. Create is checked at the file plugin's collection node; remaining
  capabilities are checked at the file node. `*` must not silently expand into plugin capabilities.
  Installation cannot grant every principal read access to every future file.
- Provisioning is explicit: an administrator uses existing `core.access.grant` to give selected
  named principals `core.files:create` at `manifold://plugin/core.files`, with `reach: node`.
  No human/agent class is enrolled automatically. Operator library oversight requires separately
  reviewed root-subtree rows naming the concrete `core.files:read` and `core.files:delete`
  capabilities; `*` supplies neither. Administrative quota inspection uses the existing engine
  storage inventory authority. Raw database/backup custody is not an application-level read grant.
- Sharing selects named principals and exact read rights; the UI previews the audience before a
  committed grant change. A canvas upload defaults to private and separately offers explicit
  sharing with selected collaborators. “Everyone viewing this canvas” is not a copied audience
  list that silently authorizes later viewers. A later viewer either has file authority or sees
  a named unavailable projection; changing canvas grants alone does not change file grants.
- File grants do not widen a container-scoped token or federated container ticket to a root-level
  file node. Such a credential still refuses, even when its principal has a file grant through a
  different credential. The UI must distinguish a selected audience from effective access with the
  current credential. A future file-scoped credential/share contract requires its own coordinated
  protocol and attenuation work; do not turn the scene reference into an implicit file ticket.
  Initial acceptance uses independently authenticated readers with explicit file grants and
  compatible credential ceilings, and separately proves scoped-credential refusal.
- Reuse the one grant store and evaluator, never a second plugin ACL. Current `core.access.grant`
  administration is root-only. **A restricted creation/share grant operation is a missing
  prerequisite**, not an existing plugin privilege. Keep that mechanism declaration-driven: for
  a node kind it owns, a plugin declares its own-namespace creator-cap set, grantor capability,
  grant prerequisites and grantable subset. The host arbitrates ownership, namespace, current
  authority, credential ceiling and exact-node scope; it contains no `core.files` branch. The
  restricted primitive accepts named-principal `allow` rows only, never class/instance targets,
  `deny` rows, inherited-grant edits or another plugin's capabilities.
  The file plugin's proposed declaration assigns its creator exactly `read`, `delete` and `share`
  on the new file, names `share` as grantor, requires `read` plus `share` to grant, and permits
  granting only `read`. It never delegates `share`. A current grantor may revoke only the
  primitive-created read-only rows on that exact file. Track grant IDs/provenance so un-sharing
  cannot revoke administrator-created or unrelated rows; report effective remaining access when
  other grants still allow reading. Grant changes and revocation remain traced through access's
  authoritative machinery. This requires explicit security/authority adoption, not a hidden
  direct store call from the file handler.
- Publication remains invisible until bytes, metadata and the required grants are committed.
  Because file and grant stores are distinct, use an explicit prepared/publication journal and
  recovery check, not a fictitious cross-database transaction. A crash before publication leaves
  no readable file; recovery either completes the exact authorized preparation or aborts it and
  removes only its own provisional grant rows. Recheck current authority before completion.
- List, resolve, inspect, open/download and every queued byte delivery recheck current authority.
  Denied/missing records give the same non-disclosing unavailable result. No filename, size, digest,
  owner, cache validator or existence hint is returned before authorization. A digest verifies
  integrity, never authority. No public bucket, signed URL, credential-bearing URL or CDN is needed.

## A — Durable files and byte lifecycle

### Backend, records and proposed limits

Use the existing engine-owned plugin `data.db` for metadata and bounded immutable BLOB chunks,
not KV strings, scene documents, untracked loose files or a new cloud service. Separate tables
hold file metadata, ordered chunks, transfer state, logical reservations and publication records.
They remain private to the owning plugin; every other plugin calls the same public actions.

Metadata includes opaque file ID, owner principal, home, sanitized display name, declared and
validated media type, byte count, SHA-256, creation time and lifecycle. Image dimensions/type
validation are derived, not trusted caller claims. Do not globally deduplicate by digest: it adds
cross-scope existence/accounting hazards without being necessary for this bounded design.

| Resource                          | Proposed initial policy                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed file                    | At most 16 MiB; zero-byte general files allowed, zero-byte images refused                                                                               |
| Logical file storage              | 32 MiB workspace-wide for committed plus reserved bytes; at most 1,000 retained records including incomplete/deleted receipts                           |
| Plugin database                   | Explicit 64 MiB manifest cap, leaving space above logical content for rows/indexes; allocation failure remains a real refusal                           |
| Byte chunk / pressure             | At most 256 KiB; at most four unacknowledged chunks per transfer; four active transfers per workspace and two per principal; no unbounded pending queue |
| Transfer lifetime                 | 60 s without accepted progress, 15 min absolute, including paused/disconnected state; expiry does not refresh on a repeated chunk                       |
| Completed reconciliation receipts | Seven days, within the record cap; after expiry an old request reports expired/unknown rather than being silently replayed                              |
| Image preview                     | PNG, JPEG, WebP and GIF; at most 4,194,304 decoded pixels and 8,192 pixels per side; animation is not admitted as a canvas image                        |
| General download/delivery         | Opaque regular-file bytes within the file limit; no automatic execution, archive extraction, HTML/SVG rendering or MIME-based authority                 |

These limits need real memory, disk and browser-corpus measurements before adoption. The database
page cap is **not** a total filesystem/WAL quota. Admission must reserve logical bytes atomically,
limit physical growth and account for WAL/checkpoint headroom under the deployment's disk budget;
SQLite-full or filesystem-full aborts the transfer without publishing a partial file. A physical
quota mechanism or equivalent bounded storage allocation remains an implementation prerequisite.
Never advertise a 32 MiB logical counter as protection against unlimited WAL or unrelated disk use.

### One lifecycle, separate byte carrier

Proposed lifecycle actions are begin upload, inspect transfer, complete upload, cancel transfer,
open read, delete file and explicit sharing. Exact public names and schemas belong in protocol at
implementation. UI picker, canvas drop, explicit clipboard save and SDK calls invoke these same
doors with the same authority, limits, errors and idempotency semantics.

Start reserves the declared maximum length and creates an actor/credential/file-bound transfer.
Its unpredictable ID is a correlation identifier, **not a bearer**. A bounded authenticated binary
HTTP carrier moves chunks outside action JSON, scene deltas, event bodies, traces and PTY traffic.
Propose a generic plugin transfer registration/host contract whose handler receives the already
admitted principal, declared node and bounded bytes; do not add a favorite-plugin branch to the
HTTP server. This carrier and its in-realm/hardened/SDK interfaces do not exist today and require
normal floor-extension justification under the existing protocol/transport pillars.

Every chunk carries an exact offset/sequence and length, is checked against the original bound,
and is acknowledged only after the chunk and transfer position are durably committed. Retrying
an already acknowledged offset with identical bytes is idempotent; different bytes or an offset
gap refuse. A token change, source change or changed declaration cannot reuse the transfer ID.
The client consults retained state after interruption, never infers success from bytes sent.

States are `receiving → verifying → ready`; `cancelled`, `expired` and `failed` are terminal.
Private chunks are unreadable throughout receiving/verifying. Completion checks contiguous
length, hashes the complete ordered content with bounded memory, checks the caller's expected
hash when supplied, validates allowed preview metadata, and performs the publication/grant
sequence above. Duplicate completion returns the same file only to a still-authorized caller.
No runtime hash object is the sole recovery record: after restart rehash retained chunks or abort
an unverifiable transfer. Incomplete bytes are removed in bounded batches after terminal failure;
reservations release exactly once. On re-enable, expire overdue incomplete transfers before new
admission, without deleting completed files.

Open-read is an audited lifecycle action. Each byte continuation rechecks the current credential,
node and original transfer scope, including immediately before queued delivery. Revocation stops
future reads and active streams server-side. A revoked viewer cannot rely on a file-node event:
the event plane correctly filters that viewer at delivery. Propose a private SDK read-handle
lease of at most 15 seconds, renewed only by an authorized continuation while mounted and checked
again on focus. A named refusal, authority-loss signal or local lease expiry revokes object URLs
and decoded projections, including when disconnected; still-authorized viewers may also hear
deletion events. This lease is part of the missing byte-carrier contract, not a claim about
today's event plane. It cannot retract bytes already received, downloaded or independently copied.
Do not promise immediate removal from a revoked client or instantaneous distributed erasure.

Serve authorized bytes with `Cache-Control: no-store`, no service-worker/CDN storage and no public
redirect. Raw downloads use attachment disposition and a sanitized filename, `nosniff`, and a
non-executable type. Canvas previews use an authorized SDK fetch and a short-lived object URL,
revoked on unmount, authority loss or plugin disable. The shared SDK owns transport; a renderer
does not create an alternate credential-bearing client. Denied range/conditional/cache requests
must not leak data or validators. No bytes, raw filenames/paths, clipboard contents, credentials
or bearer-like transfer material enter logs or traces; use opaque payloads plus bounded lifecycle
metadata, actors, canonical targets, byte counts and reason classes under existing redaction.

### Retention, deletion and recovery

Removing a canvas reference never deletes its file. Completed files remain until a separately
authorized logical delete; there is no automatic “last reference” garbage collector racing Yjs
history, undo or offline clients. Delete immediately denies future reads, cancels active reads,
and leaves referenced elements as named unavailable projections. Reclaim chunk rows in bounded
batches; SQLite page/WAL reclamation and old backup retention are different facts, not secure
erasure claims. A completed upload that was never attached remains in its owner's library and
counts against quota; offer explicit deletion rather than silently collecting it.

Disable stops admission and byte carriers and retains completed data under the existing plugin
contract. Re-enable does not replay uploads or machine deliveries. Purge requires the existing
disabled/quiescent boundary, deletes the authoritative plugin DB/KV through the owning engine
path, and leaves canvas references as unavailable, never repurposes their IDs. Cancel or reconcile
machine transfers before purging their receipts; an unknown committed remote result cannot be
made “clean” by deleting its journal. Remote copies and external backups are never silently deleted.

The hub operator owns encrypted full-state backup, custody, restore drills and rollback, not the
uploader or a plugin-selected provider. Current capture has a **256 MiB aggregate archive bound**;
a plugin DB can otherwise request up to 4 GiB. A 64 MiB file DB does not prove that all other hub
state fits. Adoption must establish an explicit aggregate backup/storage budget, preflight the
complete inventory with required headroom, and refuse file admission with `backup_capacity` when
it cannot be covered. Concurrent reservations must participate in that budget; unrelated state
can still exhaust it, so backup failure must be surfaced rather than treated as a completed copy.
Increasing quotas requires either demonstrated aggregate headroom or an independently reviewed,
compatible full-state format/capacity extension. Do not silently raise a recovery safety bound.

The engine-owned aggregate inventory/budget exposed to admission, or an equivalent engine-enforced
physical allocation sized by the operator within checkpoint capacity, is a **missing mechanism**.
The file plugin cannot compute another plugin's storage or `backup_capacity` from its private
database; the operator-run capture script is not already a runtime admission service.

A recovery drill must capture finalized files and their grants/publication journal, restore into
an empty disposable instance, and verify bytes, references and denied readers after restart.
Different databases are consistent individually, not automatically one cross-database snapshot:
quiesce file publication and associated grant changes at the checkpoint boundary or reconcile
all prepared records fail-closed before serving. Reuse the existing full-state recovery owner;
ordinary Litestream alone is explicitly insufficient. Migrations use the existing plugin data
version/image ledger; both metadata and chunk schema migrate together with pre/post-image proof.
No production recovery, secret export or live maintenance is authorized by this proposal.

## B — Canvas image projection and explicit saving

An image element stores a completed canonical file reference plus document-plane arrangement:
position, size, crop and presentation. No base64, data URL, transfer secret or local temporary path
is persisted in Yjs. A reference edit does not grant access. Rendering reauthorizes the referent
and gives a named denied/deleted/disabled/unsupported state, not a blank canvas or a speculative
image. All viewers consume the same reference and decoder policy.

Picker/drop/explicit clipboard save first shows the selected audience, file identity and bounded
progress. Its local pending affordance is visibly incomplete and cannot be mistaken for a shared
attachment. Only a ready authorized file may be attached through the owning action's commit
point, with `scenes:write` on the target and file read authority both rechecked. The scene reference
is the document-plane effect of that commit, not an alternative file authorization path. A direct
hostile document reference cannot bypass read checks or create a readable incomplete file.

If file completion succeeds but scene attachment fails or permission is revoked, report “saved,
not attached” and keep the file in the library. Retrying attachment is idempotent for its request;
it must not duplicate elements. Do not claim an atomic transaction spanning the plugin database
and a collaborative scene. Moving/resizing/cropping an existing authorized element remains an
ordinary document-plane edit. Deleting one reference does not affect other references or grants.

Preview validation rejects malformed/truncated images, dimension/decompression bombs, MIME
mismatches, SVG/HTML and animated inputs for canvas use; the original bytes can remain an opaque
file only after the user explicitly chooses that distinct outcome. Do not silently transcode or
retain a failed image. Evaluate a maintained bounded decoder before choosing implementation or a
new dependency; header sniffing alone is not decode proof. Preserve original bytes and their hash;
any later thumbnail is a derived private resource, not a second logical file or public URL.

The browser corpus includes supported PNG/JPEG/WebP/GIF, clipboard-produced PNG, transparency,
orientation/color metadata, malformed/truncated content and oversized dimensions. Test actual
supported browsers and accessibility states, not merely API status. Clipboard-only native terminal
paste creates no retained file. A separate **Save/share file** gesture may use the same selected
bytes, with the audience visible, and never captures clipboard contents on a timer or from output.

## C — Explicit machine delivery and download

### Approved roots and collision policy

Machine delivery requires source-file read plus the exact destination machine's reviewed,
revision-bound authority and consent for exclusive named-child creation. Propose a plugin-declared
**managed state root** as the sole initial write destination. The machine administrator deliberately
installs and consents to that location for the exact plugin/artifact revision; enrollment or root
credentials are not consent. No Downloads/home/cwd default, arbitrary absolute destination, implicit
directory creation outside the managed root, remote filesystem browser or SSH traversal is included.

Named-child creation is a **new location access mode/right**, not today's `locations:create`.
The current resolver refuses create access on managed locations; ordinary create authorizes only
the exact manifest-declared path, not a caller-named child. Adoption must extend the owner protocol,
location schemas, consent review and held-root resolver together. The new right authorizes only
exclusive regular-file publication beneath that reviewed root, never general directory write.

Address a destination as machine ID, installed plugin/artifact pin, location ID/revision and a
bounded relative filename. Initial writes accept a single normalized filename component; reject
separators, `.`/`..`, NUL/control characters and ambiguous platform spellings. Display names are
not paths. Extend the existing trusted-anchor and held-descriptor mechanisms to hold and resolve
this new destination mode. Reject symlink/magic-link/mount escapes, unsafe file kinds, root
replacement and alias/writer conflicts; string normalization or a `realpath` check followed by a
path-based open is not confinement.

**Create only, never overwrite.** Publish with atomic exclusive creation. A collision reports
`destination_exists`; the user explicitly chooses a different name. Do not auto-suffix silently,
replace an existing file, or offer destructive overwrite as a hidden retry. Return the actual
machine, location identity and resolved relative/absolute display path only after verification;
the path is private result data, not a capability or a public audit field.

For machine-to-browser download, the administrator separately approves an exact declared read
root. The user supplies a bounded relative path within it; no directory listing is implied. Open
only a regular file by held descriptors, seal a bounded immutable read snapshot and verify its
length/hash. A concurrently changing source must refuse or produce a verifiably stable snapshot,
not mix revisions under a successful checksum. Read permission on the source and caller download
authority remain live throughout. Saving that snapshot as a shared Manifold file is a separate
explicit action; downloading to the browser does not silently retain it in the library.

### Reuse, missing mechanism and truthful completion

Reuse the proved native-owner channel, installation/consent review, confinement primitives and
current authority/fencing machinery; extend the resolver for the new location mode above. Add a
neutral, typed, bounded transfer primitive to that channel and its exported plugin context:
put/read/cancel/status with chunk acknowledgement and a durable owner receipt. This is **not
shipped**. Existing job `inputs` are same-machine sealed-output bindings; `inputFiles` are bounded
operation-declared generated files, including literal/input strings and service-bearer bindings,
inside the job's declared home. `ctx.jobs.outputs` reads finished job outputs, not arbitrary paths.
None is a general upload API. Do not issue shell copy commands, PTY input, ambient HTTP fetches,
a second machine socket or private output-store reads to pretend otherwise.

A delivery binds transfer ID/idempotency key to source ID/hash/length, actor/credential, exact
machine enrollment and proved owner generation, installation/artifact/location revisions, name,
create-only policy and expiry. Chunk sequence and total bytes are bounded. Write to a private
same-filesystem temporary sibling opened from the held root; verify digest and length, sync it,
then request the current-authority publish permit. No chunk is a durable success claim.

Authorization linearizes at a fenced publish-commit decision. Pre-commit revocation refuses;
post-commit revocation cancels unfinished work but cannot retract an already published independent
copy. A disconnected owner must not publish using a stale uncommitted permit; short expiry,
owner-generation binding and durable consumed-permit state are required. Atomic exclusive
publication, file/directory sync and a retained receipt let status reconcile a lost acknowledgement
without a second copy or overwrite. Crashes between publication and receipt need a prepared
identity/inode record so recovery verifies the exact candidate; a pre-existing same-hash file is
not proof that this transfer created it. If it cannot establish that proof, report `outcome_unknown`
and require reconciliation, never “failed, safe to retry” or automatic deletion of an unrelated file.

Public states distinguish queued/not started, transferring, verifying, publishing, completed,
cancelled, refused, failed and outcome unknown. A completed receipt includes actual destination,
verified length/hash and exact owner/installation identity. Cancellation removes only the run's
private temporary bytes and never revokes unrelated credentials or removes a committed copy.
On disconnect/restart inspect retained state; no blind replay. Disabling or replacing the plugin,
consent, location or owner stops new work and fences stale continuations. Work without supported
held-descriptor enforcement and durable evidence refuses by name; the current governed owner is
Linux x64/arm64, not evidence of a safe Windows/macOS transfer backend.

Hub and machine copies have independent lifecycles. Deleting/revoking the hub file stops future
reads/deliveries; it does not remove a completed machine copy or promise to erase downloaded bytes.
Remote delete/overwrite is outside this initial policy. Machine storage exhaustion, inode exhaustion
and hash mismatch leave no completed destination; unknown post-publication outcomes remain explicit.

### Terminal affordance

An incompatible terminal drop offers **Save file**, then **Deliver to machine** with the actual
enrolled machine, managed location and audience shown. Each effect is deliberate. The terminal's
owner machine can be shown as a suggestion only; a nested SSH process does not change its authority
or prove that destination hosts the application. Permit selecting another enrolled, approved
machine explicitly; otherwise explain the unsupported destination rather than inventing a path.

Managed roots are private to the native owner's OS UID. A terminal application can use this path
only when its OS access is compatible, normally the same UID; machine enrollment and PTY control
do not prove that fact. Show this limitation before placement and never change mode/ownership to
make a path appear usable. A differently privileged application needs a separately reviewed
destination policy; the initial managed-root design does not promise that access.

After verified completion, offer copying the actual path or deliberate path insertion through the
normal controlled terminal-input boundary. Never send Enter, a shell command or file bytes. Insertion
requires current PTY write/control authority, rejects control characters, and previews exactly the
text sent; it must not assume a shell quoting dialect. Copying the path is the safe default. State
“file delivered; application consumption unknown” unless an independently supported consumer protocol
proves consumption. Native MIME paste stays its existing one-use, non-retained path.

## Adoption and compatibility work

This is a design deliverable, not an approved implementation sequence. Before implementation,
record adoption of ownership/IDs, private sharing and restricted grant semantics, quotas/decoder
policy, aggregate backup responsibility and create-only managed-root delivery. No new provider or
new foundation pillar is proposed. The implementation must cover all three deliverables, even if
coherent commits land in dependency order:

1. Specify protocol reference/capability/transfer schemas and the restricted access primitive;
   implement the same mechanism for UI, SDK and hardened plugins. Apply floor admission to new
   neutral host surfaces under existing pillars, with a dated ADR and current spec updates.
2. Implement plugin-owned records, reservations, publication recovery, authenticated binary I/O,
   disclosure prevention, decoder bounds and library UI. Prove backup/restore and real quota failure.
3. Add the declared canvas child and actual multiplayer image projection, with explicit save/share
   and saved-but-unattached recovery, preserving clipboard-only non-retention.
4. Add the bounded owner transfer protocol, exact consent, confined create-only/read locations,
   durable completion reconciliation and terminal affordance; prove actual remote bytes and path.
5. Migrate every consumer and update live schemas/registries/docs together. Public and persistent
   formats need coordinated compatibility and rollback; machine protocol changes require the normal
   hub-before-agent order and explicit installation authority, not an automatic fleet upgrade.

Do not write an accepted ADR without its normative spec change, pre-register nonexistent plugins,
mark future scenarios passed, or turn a guessed API in this proposal into a compatibility promise.
Open PR ownership and full-state recovery work must be coordinated before changing their mechanisms.
Dependencies or codec libraries require the normal named evaluation and dated dependency decision.

## Future acceptance matrix

Every row is **unrun**. It preserves #370's future implementation criteria rather than claiming
that a design document or existing substrate satisfies them. Fixtures use generated content and
run-owned disposable principals, machines and storage; live operations require separate authority.

| ID  | Boundary and scenario                                                                                                       | Required observable evidence                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Two browsers and one SDK agent; upload, explicitly grant, depart, restart, rejoin                                           | All authorized readers obtain identical SHA-256/length; decoded image dimensions agree; stable file URI and no dependence on uploader connection                                 |
| A2  | Denied principal guesses ID/digest, lists, resolves, requests direct/range/conditional URLs and cached resources            | No bytes or metadata/validator/existence disclosure; service worker and browser cache cannot resurrect a denied read                                                             |
| A3  | Revoke during upload, verify, read, queued send and grant/publication preparation                                           | No unauthorized publication or later delivery; exact named refusal/terminal state, reserved bytes released once; previously downloaded bytes are not claimed erased              |
| A4  | Concurrent starts at byte/count/concurrency limits; duplicate/gap/changed chunks; zero-byte file; oversized/truncated input | Correct reservation and idempotency outcomes, bounded queues/memory/storage, no partial ready file or silent retry beyond expiry                                                 |
| A5  | Kill/restart at every chunk/finalization/publication boundary; capture/restore around grant and file commits                | Either exact ready bytes with effective grants or unavailable incomplete data; no cross-database torn authorization, no fabricated success                                       |
| A6  | Filesystem/SQLite/WAL exhaustion, aggregate backup limit, missing/invalid checkpoint; schema migration and rollback         | Explicit failure with no uncontrolled growth; encrypted full-state restore retains bytes and denial semantics; replica-only restore is never presented as complete               |
| B1  | Real picker/drop/explicit clipboard-save UI, same SDK workflow, keyboard/screen reader, progress/cancel/reconnect           | Audience and destination visible; only completed authorized files attach; visual inspection of transitions and usable focus/error states                                         |
| B2  | Two canvases reference one file; remove/undo/offline-edit one reference; delete logical file separately                     | Other references survive reference removal; logical delete makes every future projection unavailable without deleting scene history or unrelated files                           |
| B3  | PNG/JPEG/WebP/GIF corpus across supported browsers; orientation/transparency, malformed/animated/bomb/unsupported cases     | Matching original bytes and bounded decode; admitted dimensions/rendering verified; unsupported preview does not silently upload/transcode                                       |
| B4  | Upload succeeds but scene permission is revoked or attachment acknowledgement is lost                                       | Honest saved-not-attached state; retained library file; idempotent attachment retry, no duplicate element or hidden file deletion                                                |
| C1  | Browser and SDK deliver then independently inspect destination; machine file downloads to browser                           | Actual approved machine/path plus matching length/hash; source read and destination consent both evidenced; no application-consumption claim                                     |
| C2  | Traversal, separators, symlink/magic-link/mount/root swaps, non-regular sources, concurrent source writes and collision     | Refusal outside the held approved root; existing destination bytes unchanged; coherent stable source snapshot or refusal                                                         |
| C3  | Cancel/disconnect/revoke/disable/replace owner or installation at receive/verify/publish/ack; fill destination disk/inodes  | No new publication after a pre-commit refusal; exact completed receipt or explicit unknown outcome after the commit boundary; no duplicate replay/overwrite or unrelated cleanup |
| C4  | Nested SSH, unenrolled target, unsupported OS/enforcement and missing/expired consent                                       | Explicit unsupported/denied state; no guessed host, shell/PTY fallback, fabricated path, raw binary text or automatic Enter                                                      |
| C5  | Clipboard-only terminal paste, explicit save, explicit delivery, copy path and optional insertion                           | Only explicit save creates a retained file; audience shown; insertion separately authorized; actual consumer receipt distinct from placement                                     |
| L1  | Disable/re-enable/purge/uninstall, active/unknown transfer, existing images and independent remote copy                     | Retain-only disable, no replay on enable, bounded cleanup, named unavailable projections after purge, remote copy untouched and cleanup failures visible                         |
| L2  | Tampered credentials/IDs, reused idempotency key, stale grants/consent/artifact, traces and logs                            | No authority widening or alternate door; bounded lifecycle attribution without content, private paths, clipboard bytes or secrets                                                |

## Design-delivery reconciliation

The selected A+B+C scope is fully specified here; none is replaced by job artifacts, installation
uploads or native clipboard. The original requirement to defer implementation is preserved. The
original runtime acceptance remains explicitly future and unrun in the matrix, not superseded or
checked off. Adoption and implementation require their own authorized work; this document creates
neither a runtime feature nor permission to perform live transfers.

[#370](https://github.com/atyrode/manifold/issues/370) remains the tracker for adoption and every
unrun A1–L2 scenario; no separate implementation tracker is created to make the design PR appear
complete. The design PR uses `Refs #370`, records the completed proposal and the remaining
runtime/operational acceptance, and does not close the issue merely by publishing this document.
