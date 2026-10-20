# Terminal image admission charges what a snapshot carries

Date: 2026-10-20
Status: accepted

Issue [#936](https://github.com/atyrode/manifold/issues/936). ADR 0060 is a separate
decision; this record takes the next number. It replaces the **Resource policy**
section of [ADR 0031](0031-terminal-inline-graphics.md) and that record's snapshot
reservation paragraph. ADR 0031 stays as written: its pinned addon seam, capability and
color ownership, snapshot ownership, no-gap continuation and maintenance boundary are
unchanged and still govern.

## Problem

ADR 0031 admitted an image under four independent budgets: 180,000 encoded bytes, 2,048
canonical 7×14 cells, 2,097,152 decoded pixels and 131,072 Sixel input bytes. The cell budget
alone refused a 700×282 Sixel (2,100 cells) whose sequence was 312 bytes. The input budget
refused every landscape and photo preview that installed OMP 18.4.12 emits: in a real PTY at
100, 120 and 160 columns, OMP negotiates Sixel and 7×14 cells through the terminal host and
draws 490×276 previews of 168,312–198,006 bytes, and 639×360 pre-negotiation frames of
257,469–327,823 bytes. Only its 152×276 portraits fitted, so a retained version-1 host kept four
portraits and no landscape. Refusal also came late: the browser uploaded a canvas and could
read it back before rejecting the footprint. Sixty 1200×900 Sixels (1,081 bytes each) produced a
258 ms main-thread task and 251 ms key delay through the full hub path. Every refusal used one
sentence that named no resource.

The same snapshot payload limit still binds. A terminal snapshot carries at most 449,992 UTF-8
bytes (`MAX_SNAPSHOT_BASE64_CHARS` 600,000 less framing), and ADR 0031 reserved 267,000 for the
graphics envelope plus 180,000 for one unfinished control: 447,000 together.

## Decision

**One charge per retained image, in snapshot bytes.** An image costs
`128 + 4·⌈encoded/3⌉ + 8·footprint`: its JSON entry, its base64 data and one six-byte placement
record per canonical tile. The cell budget is gone because every cell is already charged. The
447,000-byte reservation is unchanged and is split explicitly: 2,000 for the envelope skeleton
and palette, 180,000 plus a 2,048-byte header for an ordinary unfinished control (a maximal
iTerm file), and 262,952 for retained images. The 64-image and 2,097,152-pixel limits and the
2,048-pixel side limit stay. On a wider grid the pinned addon extends an image row to the
right; after wrapped rows were split, that would repeat tiles still placed below. A row's
expansion stops at its first tile the buffer already places, so a run never overtakes its
continuation. Any copy of the next tile therefore lies at or below that row, and viewers
holding the row make the host's decision and keep one placement per tile. A viewer following a
version-1 host keeps that host's unrestricted expansion. As a guard, the host serializes each
tile's top-most placement once. The serializer still fails explicitly if an envelope exceeds
its share.

**A Sixel may be larger than an ordinary control.** Sixel input is limited to 393,216 bytes.
While a Sixel payload `P` is in flight beyond the 180,000-byte control share, the oldest images
are evicted until the cache fits `262,952 − (P − 180,000)`, so the envelope plus the replayed
continuation never exceed 447,000. The rule depends only on payload bytes counted the same
way (UTF-8) in the mirror and every viewer, and it is monotone in `P`. Evaluating it at any
parser chunk boundary therefore leaves every peer with the same cache at every sequence
watermark. Other DCS and OSC controls keep their 180,000-byte continuation cap.

**Refuse from metadata before work.** A shared Sixel gate reads raster attributes before the
pinned decoder commits its canvas and refuses an impossible side, pixel count or footprint
there. Level-1 Sixels learn their extent while decoding and are refused before upload. iTerm
images are refused from header dimensions and file size before decoding. The browser charges
an admitted Sixel from the decoder's own pixels through the shared lossless encoder, so no
`getImageData` readback precedes admission. The mirror stores that encoding directly instead
of copying RGBA. Decodes of 65,536 pixels or more yield to the event loop before upload,
guarded against snapshot generation changes. A refused Sixel continues for late viewers as the
ignored `ESC P + q` marker, because every peer refuses the same bytes.

**Name the limit once.** A refusal carries its resource with observed and allowed quantities,
for example `2100×300 exceeds the 2,048-pixel side limit.` or `Sixel data exceeds the 393,216-byte
input limit.` Each resource notifies at most once per terminal view: OMP's Sixel renderer
resends a visible image on every frame while it stays in its live window, so a time-windowed
notice would still recur throughout a streamed reply. Notices
record quantities only, never pixels or terminal bytes.

## Compatibility and upgrade

The host now emits a version-2 graphics envelope. Its schema requires at most one placement
record per tile of each image. A protocol-57 browser would refuse that envelope, keep its
old admission for live output and misplace text after an image it alone refused. Protocol 59
therefore moves session joins through the existing protocol-skew reload. Machine, instance,
native-owner and terminal-host IPC frames are byte-identical, so those compatibility sets add 59.
Protocol 58 is skipped because an open draft already reserves it.

A terminal host is retained across transport and hub replacement. A host from before protocol 59
keeps its version-1 admission, and a current browser follows it: the envelope version in each
snapshot selects the policy for the live output that follows. Such a terminal keeps the old
limits, refusals named against the old 2,048-cell budget, until its host is replaced through
normal maintenance. Rolling a hub and browsers back below 59 while a version-2 host is retained
requires replacing that host as well, because older browsers refuse version-2 envelopes. This
decision authorizes no fleet restart or production activation.

## Residual limits

One retained image costs at most 262,952 bytes, about 182,000 encoded bytes for a 639×360
frame and 189,000 for a 490×276 preview. Lossless palette encoding keeps OMP's negotiated
previews inside that: the synthetic session's last portrait retained 30,546 encoded bytes and
its last 490×276 preview 114,531, a 164,036-byte charge. The cache therefore holds one such
content-rich preview beside smaller images; older images are evicted in FIFO order on every
peer. A photo-like 639×360 frame drawn before OMP receives its cell size can exceed the
cache. It is refused with a named notice and OMP's negotiated redraw is shown. An oversized
in-flight Sixel displaces cached images up to its input limit.

## Alternatives rejected

Raising the cell constant would overrun the snapshot reservation for any image with dense
placements. Raising the snapshot ceiling changes every frame bound on the session and machine
wires. Lossy encoding, native PNG/JPEG codecs in the terminal host or a deflate stage add a
dependency or browser decompression path for a gain the lossless palette codec already gives
ordinary screenshots. Per-viewer budgets break late-viewer agreement. Special handling for OMP
would make other Sixel and iTerm producers wrong.

## Verification

On the original 2026-10-03 base, a disposable hub, spawned terminal host and headless Chromium ran the same probe on the base
tree and this change. It used real PTYs, viewers that were live, simultaneous, late (attached
inside a 250,000-byte Sixel prefix) and reconnected, a resize, and FIFO eviction. In both runs
the viewers agreed on text and image-layer pixels. After the change, cell-cliff images render
without notice, the 60-image burst shows no long task (before: 258 ms), and refusals name their
resource. Installed OMP 18.4.12 ran network-isolated with an empty HOME and no credentials, so
it sent no provider request. It resumed a synthetic screenshot session at 100, 120 and 160
columns and rendered its negotiated landscape and photo previews. Late viewers matched them
pixel for pixel, and typed input reached OMP's editor. Focused regressions cover the cliff
boundary, metadata refusal, the refused-Sixel marker, chunking-independent eviction at a
watermark, the joint reservation, legacy envelopes and encoder aliasing. A real-browser test
covers no upload before refusal, named and de-duplicated notices, legacy policy selection and
version-2 restoration.

On the rebased protocol-59 tree, a development hub and its spawned terminal host served the
built application to headless Chromium at 152×57. OMP's own TUI renderer drew a photo-like
490×276 preview as a 351,025-byte Sixel, then streamed twelve lines below it, resending the
image on each frame. It displayed with no notice, and a later viewer restored it from the
snapshot. Installed OMP 18.12.3 resumed a session whose dithered screenshot preview the former
131,072-byte limit refused. It displayed and survived four font-size resizes with no notice.
Twenty repaints of a 1,550,552-byte Sixel produced exactly one notice naming the 393,216-byte
input limit, and following text and the shell prompt were intact. The 60-image burst recorded
no long task; the same observer recorded a deliberate 120 ms control task. Further regressions
cover a reflow that repeats a tile on a second row, and version-1 palette updates from a
refused Sixel.
