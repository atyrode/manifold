# 0057 — Private files use ordinary grants and bounded byte transports

Date: 2026-09-29
Status: accepted

The living specifications are [CONTRACTS.md](../CONTRACTS.md),
[PLUGINS.md](../PLUGINS.md), [REGISTRY.md](../../REGISTRY.md) and the recovery procedure in
[SELF-HOST.md](../SELF-HOST.md). This records the mechanism and dependency decisions for
[#370](https://github.com/atyrode/manifold/issues/370), including the full A+B+C contract in
[the adopted design](../spikes/shared-file-contract.md). It is not a claim that implementation,
release, deployment or operational acceptance has already passed.

## Problem and ownership

A scene reference cannot carry durable file bytes, and a terminal clipboard exchange cannot
silently become a retained shared file. Job inputs/outputs and installation artifacts are not
an arbitrary-file transfer service. The existing plugin database provides private durable rows,
but neither its page cap nor a plugin-local counter proves bounded WAL growth or that the hub's
complete encrypted checkpoint still fits. Root-only grant administration does not imply that a
plugin may write arbitrary grants on behalf of an uploader.

Use two opt-in owners: `core.files` owns independent immutable files and explicit machine
transfers; `core.files.images` requires Files and Canvas and owns the image projection. Disabling
Canvas must not hide the file library. The image child stores only an opaque file reference and
presentation geometry. Removing the last visual reference is never logical file deletion.

A file URI is `manifold://file/<opaque-id>`, a protocol-admitted root-child leaf. This is one
resource kind in the existing reference algebra, not a runtime URI-scheme registry. Distribution
and durable ownership reservations arbitrate the kind even when an owner is disabled, missing or
purged; another installation cannot reinterpret surviving URIs or administrator grant rows.

## Foundation and plane decisions

The missing mechanisms belong to existing pillars:

- Protocol owns closed reference syntax, declaration schemas, bounded binary continuation
  envelopes and native owner compatibility. Plugins cannot invent URI kinds or wire frames.
- Transport owns authenticated bounded delivery, cancellation and backpressure. File lifecycle
  commands remain ordinary discovered actions; bytes never travel in their JSON arguments,
  scene deltas, event bodies, public traces or PTY input.
- Storage owns private SQLite files, physical allocation accounting and authorization-coherent
  recovery. The plugin owns metadata, chunks, quotas and retention policy, not sibling paths.
- Identity owns the one grant store/evaluator and current credential/Run confinement. A
  publication row is an existence gate, not a second ACL.

There is no new foundational seat, privileged core-file branch, plugin-selected cloud service,
ambient filesystem authority or second machine connection. Each new declaration and native API
has the same in-realm and hardened meaning. Another owner can use the mechanisms without naming
Files; the compiler/host reject undeclared attachments and conflicting ownership rather than
choosing a registrant by order.

The file-level findings are criterion-by-criterion, not temporary exceptions:

| Existing pillar | Bootstrap circularity | Neutrality | Arbitration |
| --- | --- | --- | --- |
| Protocol | Inputs must be decoded before an owner or contribution can run. | Reference, byte, native-transfer and transient-panel envelopes name declared owners, not a privileged implementation. | One grammar and set of bounds decide what all producers may send. |
| Identity/capabilities | An unpublished object has no pre-existing node on which its owner could authorize publication. | Declared capabilities and exact credential lineage are evaluated by the ordinary grant store. | `reference-service.ts` coordinates existence, provenance and current authority across owner callbacks without a second ACL. |
| Persistence | Private database growth and whole-instance capture must be admitted before a plugin writes. | `recovery-budget.ts` and `recovery-gate.ts` account for physical images and writer lifetimes, not file-domain rows. | One reservation/fence arbitrates competing owners, WAL, migration stages and coherent checkpoint scratch. |
| Transport | An isolated owner cannot open the authenticated HTTP/machine boundary or prove its own native installation. | Byte carriers and native contexts interpret declared templates, current caller and consent, never a core-file shortcut. | The shared services enforce bounded continuation, cancellation, owner generations and durable terminal evidence. |
| Browser host/design system | A Worker cannot mount another owner's UI, capture DOM files or own a main-thread object URL. | Byte surfaces, portable element edits and borrowed panels resolve declared contributions and bounded data. | The host owns custody, whole-subtree admission, current mounted authority, resource cleanup and one result per intake. |
| Assembly engine | Trusted guest code must be composed before its supervised owner exists. | Files and its image child use the same registered definitions and loader as other owners. | Only the two explicitly inventoried guest entry files join the existing exact composition-root import exceptions. |

### Compose the owner, not its implementation

Terminal intake and the image child do not import Files' web components. A generic
`BorrowedPanel` resolves the registered owner in its selected execution mode. Native mount
sites use the same projection-registry panel component. Ephemeral input is distinct from a
persisted tile argument: native `File` objects enter only the receiving mount's resource store,
and portable props carry owner-local descriptors, not another mount's handles. The ordinary
4 KiB JSON-record limit applies to options. One result is bounded to 64 KiB UTF-8 and 32 levels;
the larger result allowance accommodates a legal fully escaped native receipt path, not bytes.
The borrowing subtree has four slots and refuses cycles. Client, credential, container,
owner and mount retirement fence callbacks and resource custody.

The parent's `/contract` owns shared DTO schemas. S18 narrowly admits the already-adopted
`zod` schema DSL there, alongside platform-free floor entries; it still excludes React, DOM,
runtime state, child imports and every sibling implementation. Duplicating validators in the
child or promoting Files metadata into the neutral protocol would create a second authority.
This is not permission for arbitrary contract dependencies. The pure `@manifold/plugin/action`
entry exposes the existing action-definition mechanism to portable bundles without importing
the broader engine barrel.


## Private publication and restricted sharing

The owner declares its read/create/delete capabilities, exact creator-cap set and restricted
sharing rule. The host validates own namespace, declared capabilities, bounded unique sets,
registered kind ownership and a real workspace resolver action. For Files, create is checked at
`manifold://plugin/core.files`; creator rights are exactly file-node read/delete/share. Sharing
requires current read plus share and grants only read to a named principal on that exact node.
There are no class targets, deny rows, subtree grants, foreign capabilities or delegated share.

Create permission derives the reviewed creator rights on the newly allocated node; the caller
cannot already have a grant on an unborn host-selected ID. This does not widen the caller's
credential. Engine token caps remain engine caps: plugin rights are evaluated through ordinary
node grants, never added to `*` or minted into credentials. Delayed work restores its original
non-secret `CredentialReference`, not its principal alone. Every operation checks live actor,
current action requirements, scope/Run confinement and installation/request lifetime. A stable
SHA-256 `credentialBinding` over canonical lineage lets a guest compare transfers without
receiving a bearer or the full authority record; it conveys no authority itself.

Publication crosses two databases in an explicit order:

1. The host records a bounded prepared intent with fresh reference/preparation IDs, request
   binding, original credential and policy identity. It creates no grant.
2. The owner commits immutable verified bytes and a ready descriptor tied to that preparation.
   Plugin-ready alone is unreadable.
3. A private bounded owner probe confirms the committed ready identity. After that await, the
   host restores authority and rechecks request/installation lifetime.
4. One synchronous main transaction changes prepared to published and inserts the ordinary
   creator grant, provenance and audit. That commit is the visibility point. Authority-change
   listeners run after the outer transaction commits.

No SQLite transaction spans a plugin await. Ready data cannot be reclaimed before the host
publication becomes terminal. Delete commits host-unpublish and removes only mechanism-owned
creator/share grants first, fences reads, then reclaims matching owner data in bounded batches.
Administrator grants may remain; they cannot make a deleted publication readable.

A share has explicit grant provenance and an idempotent exact publication/recipient/cap identity.
Revocation can remove only this mechanism's share rows, never creator, administrator, token-bound,
foreign-node or unrelated-cap rows. Audience pages are bounded. Remaining administered principal
read access is distinguished from effective access with a particular credential; other grant or
token inventories are not disclosed. All grant effects retain the actual parent action trace.

Restart aborts unpublished preparations rather than borrowing installer authority to finish them.
A private data-only reclamation callback receives only matching aborted/deleted preparations.
Published missing or mismatched ready data is quarantined, not classified as provisional garbage.
Lost publication/share acknowledgements reconcile committed receipts without recreating a grant
that an administrator later revoked. A normal process restart does not invalidate intact published
content merely because an in-flight installation generation changed.

The publication commit durably marks its owner acknowledgement pending. The ordinary call
awaits the private published-phase probe and rechecks live caller and dispatch authority before
returning; a failed acknowledgement cannot undo a committed publication. A one-second maintenance
timer retries at most four pending publications per pass with a rotating cursor, including after
restart. Hardened maintenance obtains the existing idle-only probe fence rather than overlapping
an ordinary guest effect. Busy or failed owners stay truthfully pending; missing or mismatched
committed data is quarantined. This retires private upload activity without requiring the original
reader to regain authority, replaying publication or recreating any grant.

Contract-10 isolates declaring private data callbacks serialize independent ordinary requests
into bounded owner turns. Only a host-owned, still-active call for the exact current request
and generation may re-enter a private callback; no guest-supplied parent or borrowed pending
dispatch proves that relationship. Queued work keeps its original total deadline, is cancellable
before guest entry, and retires on unload or generation change. Idle-only maintenance still
declines busy owners. Generic/older owners retain their existing concurrency, the strict
data-only fence remains intact, and there is still one process per plugin.

Revoking the immediately previous sharing decision reports the replacement principal's actual
current read audience without revoking that replacement. An unknown, non-share or older-than-retained
decision refuses with `reference_conflict`; it cannot invent an assertion that nobody can read.
Deliberate re-sharing still requires the exact retired `previousGrantId`.

## Durable file policy and non-disclosure

Metadata and ordered immutable BLOB chunks live in the owner's existing `data.db`, with one
transactional logical reservation and transfer/publication identity. No global digest deduplication
is introduced. Original bytes and SHA-256 remain authoritative; preview validation never silently
transcodes or creates another logical file.

Initial bounds are 16 MiB per completed file, 32 MiB committed plus reserved logical content,
1,000 retained records including incomplete/deleted receipts, and a 64 MiB database. Chunks are
at most 256 KiB, with at most four unacknowledged chunks, four active workspace transfers and two
per principal. Idle expiry is 60 seconds and absolute lifetime is 15 minutes, including disconnects;
repeated chunks do not refresh progress. Reconciliation receipts live seven days within the record
cap. Zero-byte general files are allowed; zero-byte images are not.

Exact offset, sequence, length and content bind a retry. A gap, different bytes, changed token or
changed declaration refuses; the sender consults durable state after interruption. Completion
rehashes ordered retained chunks, validates the declared length/digest and required media proof,
then publishes through the sequence above. Reservation release and reclamation are idempotent.

List, resolve, inspect, open-read and every continuation require live authority before metadata.
Denied/missing/disabled/unpublished records give the same unavailable projection, without filename,
size, hash, owner or validators. Collection notifications carry only non-sensitive invalidation,
not an unauthorized file catalog. Container membership or a container-scoped ticket is not a
root-level file grant. Explicit selected-principal sharing never enrolls future canvas viewers.

## Binary continuation and browser custody

A manifest declares bounded incoming/outgoing carrier attachments and their capability/ref kinds.
The host authenticates and admits the exact target, then invokes the owner's authorization check
before reading a request body. Contexts are request-owned and expose only own data, checked
publication reads and the required native read continuation—not action, grant or publication
mutation APIs. Every asynchronous boundary and queued response delivery rechecks authority and
lifetime. Retired leases cannot write after timeout, disable, replacement or shutdown.

The carrier is authenticated HTTP, exact-offset rather than HTTP Range, with no-store, nosniff,
attachment/octet-stream bytes, no redirects and no ambient credentials. Conditional/cache requests
cannot become a metadata oracle. There is no unbounded request queue: the transport bounds active
requests globally, per principal and per transfer. Its short request deadline is distinct from a
transfer's durable lifetime. A lost/ambiguous write acknowledgement is not proof that no bytes
committed.

The SDK owns this transport for agents and renderers. Mounted preview handles have a local lease
of at most 15 seconds, renewed only through an authorized continuation and checked again on focus.
Expiry, refusal, unmount, disable or authority loss revokes object URLs/decoded projections even
without a deliverable file event. This bounds the application's retained projection; it cannot
retract bytes already received, independently copied or downloaded.

Picker, canvas drop and explicit clipboard save use the same lifecycle doors. A completed upload
whose scene attachment fails remains a private library file with a saved-but-unattached outcome
and an idempotent attachment retry. An invalid image is not silently retained as an opaque file;
that requires a distinct explicit choice. Native terminal paste remains local-only unless the
user separately chooses Save/share file.

## Bounded SQLite and aggregate recovery admission

Choose the optional `bounded-wal-v1` profile rather than presenting a logical counter as a disk
quota. Its image cap is 4096-aligned and at most 64 MiB; unprofiled databases keep their existing
contract. Allocate the complete image durably before creating/opening a new writable profiled
image, retain that allocation through disable/missing builds, and release only after own files
are durably purged. Staged migrations charge retained prior and new image obligations.

The profile keeps WAL and FULL synchronization, disables cache spilling, requires successful
TRUNCATE before each transaction, and wraps query/run/batch in explicit immediate transactions.
`query` may execute DML RETURNING: validate complete result budgets before commit. A pinned reader
refuses the next transaction before another WAL version is appended. No fallible post-commit
maintenance may turn a committed success into a reported failed write.

For page count P and 4096-byte pages, reserve P+16 WAL frames, not P: FULL synchronization may
repeat the last frame to pad a sector, whose sanitized SQLite maximum is 64 KiB. Thus the WAL
bound is `32 + (P+16)*4120`, and SHM is `32768*ceil((P+16+34)/4096)`. A 64 MiB image family is
134,840,736 file-length bytes; a 130 MiB allocation envelope conservatively rounds the family on
supported local filesystems with allocation granules no larger than 64 KiB. Dirty-page memory is
bounded by an image plus SQLite overhead, not by the smaller logical-content limit.

Keep the current encrypted checkpoint ceiling: 256 MiB and 10,000 files, including archive/header
and envelope overhead. A fresh complete inventory charges full profiled allocations (even absent
images), actual unprofiled SQLite page counts, other retained files, and stage/backup obligations.
Reserve 8 MiB checkpoint safety, 16 MiB disk headroom and up to 256 MiB capture scratch on its actual
filesystem. Admission is serialized; two allocations cannot spend the same capacity. Incoming
bytes/publication refuse `backup_capacity` or `storage_capacity` when coverage is unavailable.
Read/delete/GC on an existing allocation do not depend on fresh admission margin; their bounded
transactions may still meet a real ENOSPC/SQLITE_FULL. External writers can consume free space:
these are bounded growth and conservative admission, not an OS block reservation. An ambiguous
commit is reconciled, never blindly replayed. No new cloud-provider configuration is inferred
from the capacity API.

Actual Bun/SQLite 3.53.2 research observed eight full-table rewrites in one spill-disabled
transaction leave WAL at zero until commit, then 63,406,832 bytes for a roughly 60 MiB fixture.
Twenty-four truncate-before-write transactions stayed at 1,058,872 bytes; a pinned reader returned
busy before a further write, and page-cap FULL rolled back unchanged row count. This is evidence
for the mechanism, not proof of filesystem ENOSPC or the final integrated API. The sector padding
bound follows [SQLite pager](https://github.com/sqlite/sqlite/blob/master/src/pager.c) and
[WAL](https://github.com/sqlite/sqlite/blob/master/src/wal.c) implementation.

## Authorization-coherent checkpoints

Independent VACUUM copies alone can pair an old grant image with reclaimed bytes. Acquire the
shared cross-process administrative filesystem gate, then a main-database BEGIN IMMEDIATE fence.
Snapshot main first through an independent read-only VACUUM connection, then plugin images and
stable retained files while both guards remain held. Release both before cloud upload/readback.
Administrative install/migrate/purge/enable/disable/image recovery uses the same gate across its
filesystem-sensitive phases and the same lock order.

At that main snapshot, every published file already had immutable ready bytes. Frozen main state
prevents host-unpublish, so host-first deletion cannot reclaim those bytes before their copy.
Extra plugin-ready data is safe because restored unpublished preparations abort. This proves this
publication invariant, not universal ACID across arbitrary plugin databases. A separate capture
process and 30-second watchdog bound synchronous copy work; a same-process timer cannot interrupt
SQLite. A timeout/copy/capacity failure emits no recovery receipt and must release both locks.

## Native policy artifacts and create-only effects

Use the existing transport and proved private owner, with machine protocol 49 and owner RPC 44
required for native byte frames. Older transports retain ordinary workloads but refuse this
feature and transfer-only installation. There is no compatibility path through a shell or PTY.

A transfer-only machine half uses a real reviewed inline native-transfer policy artifact: selected
full location declarations and their read/create-child rights have a canonical representation and
SHA-256 pin. It has no executable operations/tools/artifacts masquerading as useful jobs. The owner
validates and uses that exact policy; existing executable-job declarations retain their meaning.
Installation/consent must be deliberate for the exact policy/artifact/location revisions.

`create-child` is distinct from existing `create` and general write. It authorizes an exclusive
regular-file child beneath a reviewed managed state root, not Downloads/home/cwd or an arbitrary
absolute path. Initial writes take one normalized safe filename component. Held root/child
file descriptors reject symlink, magic-link, mount, replacement and writer/alias conflicts. A
private same-filesystem sibling receives bounded chunks; length/hash and file sync precede the
current-authority publish decision.

That decision is fenced to actor/credential, source publication identity/hash/length, enrollment,
owner generation, installation/artifact/location revisions, filename and expiry. The owner must
not publish while disconnected using a stale unconsumed permit. Durable consumed decision,
exclusive rename, directory sync and a receipt distinguish committed from refused/cancelled/failed.
A prepared inode identity reconciles a crash after rename; an unrelated preexisting same-hash file
is not proof of completion. Unknown commit remains unknown and cannot be erased by purge or a blind
retry. Independent committed remote copies are not retracted by later source deletion/revocation.

Download names a bounded relative path beneath a separately reviewed read root, never a directory
browser. It must produce a stable immutable regular-file snapshot, not merely hash a mixture of
concurrent revisions. A held-descriptor bounded lease/snapshot mechanism may refuse unsupported or
busy sources; ordinary path checks followed by reopen are insufficient. Download does not retain a
library file unless the user explicitly saves it. No live fleet installation is implied by code or
release publication.

Terminal fallback presents Save, then Deliver, with the actual machine audience and resulting path.
Copy path is the default. Insertion into a PTY is a separate current input-authorized choice, sends
no Enter or shell command, and never claims that an application consumed the file.

## Image decoder decision before dependency adoption

Choose `sharp` 0.35.5 (Apache-2.0, libvips 8.18.7) for maintained full pixel decode of PNG, JPEG,
WebP and GIF. [Constructor limits](https://sharp.pixelplumbing.com/api-constructor/),
[input metadata](https://sharp.pixelplumbing.com/api-input/),
[raw output](https://sharp.pixelplumbing.com/api-output/) and
[installation/platform requirements](https://sharp.pixelplumbing.com/install/) are primary
contracts; the pinned [registry record](https://registry.npmjs.org/sharp/0.35.5) records provenance.
Header sniffing and browser-only validation do not validate agent uploads. `@napi-rs/canvas` offers
a broader Skia drawing API without the same explicit input pixel/channel limits in its documented
surface; another canvas/rendering engine is not needed here. Handwritten image codecs are rejected.

Use warning-level refusal, a 4,194,304 input-pixel limit, four input channels, 8,192 per side,
sequential read, unlimited=false, no persistent decoder cache, concurrency one and a five-second
native processing timeout. Obtain metadata and a complete raw uchar decode; metadata alone is
explicitly header-only. Bound admission and elapsed request lifetime separately because the native
timeout excludes libuv queue wait. Preserve original bytes and orientation/color metadata rather
than re-encoding. Animated GIF/WebP are refused by page metadata. Sharp does not expose APNG page
count; a bounded structural PNG chunk walk rejects animation control and malformed/trailing chunk
structure before full decode. `apng-js` 1.1.5 was considered: its frame/Blob extraction and player
API add machinery unnecessary for refusing animation. No SVG/HTML reaches a decoder or preview.

An isolated Bun 1.4.2/Linux x64 experiment decoded generated 3×2 PNG/JPEG/WebP/GIF and refused
half-truncated versions of all four. A two-frame GIF reported two pages; a 2048×2048 RGBA boundary
image decoded, while 2049×2048 refused. The boundary raw result was 16,777,216 bytes in 21 ms, with
process RSS 76,677,120 bytes. This one-shot fixture is not a worst-case resident-memory guarantee.
An EXIF-6 3×2 JPEG reported oriented dimensions 2×3. The installed dependency still requires cold
native packaging proof on all four supported build targets and the actual browser corpus,
including transparency, orientation/color, clipboard PNG, malformed and oversized inputs.

Native packaging keeps the existing flat signed-member format and bounded extraction. The
code-artifact ceiling is 64 MiB; file input, image, private storage and chunk limits above do not
change. The separate updater-family aggregate remains 32 MiB, so a larger individual artifact
uses the install door rather than a batched family review. Sharp's public CommonJS export gives
the compiler a static native graph. The Files-owned build adapter selects the current supported
OS/architecture (glibc on Linux), excludes other native targets, and explicitly imports libvips
as a file asset. A short-lived FFI preload lets the unchanged binding find the library by SONAME
despite hashed asset filenames; upstream CPU checks remain in force. Bundles retain the upstream
binding license, native source/license references and version inventory. The standalone server
compiler uses the same composition-root recipes and embeds these native assets; Nix packages
also retain the notices and provide the C++ ABI runtime library.

Cold Bun 1.4.2/Linux x64 probes exercised both a relocated JavaScript/native-asset bundle and an
actual standalone executable under a separate filesystem/network namespace, with no checkout,
`node_modules`, package search path or network access. Both fully decoded a generated 2×3 PNG
using the declared system ABI libraries. A compiled hub then exercised real HTTP/SDK upload,
native image validation, publication, private-read non-disclosure and sharing in both in-realm
and hardened Files/image-child modes. Graceful writer-sealed restart preserved identical bytes
for an independently granted reader; revoking the previous share preserved its replacement,
and an unknown share decision refused. These full-hub runs had no checkout or `node_modules`
mounted, but retained loopback networking for the client. The remaining three-platform,
browser-corpus and crash/recovery acceptance is separate.

## Delivery proof

Keep all A1–L2 acceptance. Proof must cross real browser, SDK, hub restart, independent grants,
checkpoint/restore, Linux owner and rendered interaction boundaries. Inject publication/receipt
crash cuts, post-await authority loss, full/ambiguous storage outcomes and filename/inode races.
A unit fixture, a green gate, a published artifact, development activation and exact-origin
runtime verification are separate facts. This decision does not close any unexercised boundary.
