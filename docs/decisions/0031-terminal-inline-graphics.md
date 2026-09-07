# Bounded terminal inline graphics

Date: 2026-09-07
Status: accepted

Operator-directed browser-terminal image display, #423. ADR 0030 was already occupied by
stationary tile hover; this decision uses the next unreserved number.

## Decision

Pin `@xterm/addon-image` **0.9.0** in the terminals plugin and agent. It is the maintained
xterm.js addon, MIT licensed, supporting Sixel and iTerm inline images with its existing
WASM Sixel decoder, image-cell storage, erasure, scrolling, alternate-screen and resize
behavior. xterm itself remains pinned to 6.0.0. Dependency source and API review:

- https://www.npmjs.com/package/@xterm/addon-image/v/0.9.0
- https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-image

The terminal host runs the same addon on its authoritative headless mirror. A narrowly
scoped, canvas-free host adapter supplies the image primitives the addon consumes:
Sixel RGBA is copied from the maintained decoder; validated iTerm raster blobs retain their
inline bytes and declared output dimensions symbolically. The host neither starts a browser
nor decodes PNG/JPEG/GIF through a native graphics library. There are no external file,
shared-memory, URL, download, fetch or attachment sources. Unsupported formats are ignored.
The adapter's minimal `document`, `window`, `ImageData` and bitmap primitives are process-local
to the terminal host, never inherited by child PTYs. No native dependency or fleet-specific
shared library is introduced.

The browser owns actual decoding and pixels. The addon remains the image renderer and cell
store, not a second DOM overlay. Graphics use a canonical **7 by 14 pixel cell** in both
parsers; browser drawing scales each canonical source tile into the actual CSS font cell.
A small drawing adapter avoids the addon's intermediate-canvas fractional-width rounding and
per-font image copies. A spectator's font or viewport cannot change a process's cursor layout.
Resize is queued behind pending VT writes on both sides.
The Sixel default background is canonical transparent rather than viewer-theme-dependent;
explicit Sixel color pixels are unchanged. A malformed raster with an otherwise admitted
header has no pixels, but keeps its admitted cell footprint so decoder failure cannot move
following text or discard other valid images during snapshot restoration.

## Capability and color ownership

Only the terminal host answers the addon's DA1, XTSMGRAPHICS and cell/window-size queries.
Browsers consume those queries without sending competing answers. The pinned OMP 18.1.13
source probes `CSI ? 2 ; 1 ; 0 S` when no image protocol was statically selected; the host's
honest Sixel geometry reply selects its supported Sixel path. OMP retains ownership of
rendering and input routing. There is no `TERM=kitty`, Ghostty/iTerm identity spoof, application
configuration override or forced image-protocol environment variable.

Actual new PTYs receive `TERM=xterm-256color` and `COLORTERM=truecolor`. Explicit `NO_COLOR`
remains untouched: capabilities do not override an application's user color policy.

## Snapshot ownership and no-gap

The existing serializer alone loses image cells and a browser-only addon cannot restore them.
The host serializes text followed by a private `OSC 1337 ; ManifoldGraphics=` JSON envelope,
mode 5522, and any unfinished VT control. All are captured synchronously at the existing parser
drain marker and sequence watermark. The envelope contains bounded raster data, per-image
six-byte cell records (little-endian uint16 row, column, source tile), the Sixel palette,
its limit and scrolling mode. It restores the addon's own image
attributes after the text snapshot; it is not a second transport or persisted scene object.
Browser restoration is enabled only around a queued snapshot write. The headless mirror
refuses this private command from PTY output, and browsers refuse it during ordinary output.
The schema validates images, raster headers, dimensions, cell records and aggregate allocation
before browser decoding. Decoding uses inline `Blob` bytes, never an attacker-provided URL.

An image may span multiple output sequences. A bounded continuation tracker retains only the
unfinished VT control, not historical terminal output. Its suffix comes last so `S+1` can
complete a DCS or OSC begun before snapshot `S`; the serializer cannot supply this parser
state itself. A string ending with ESC has already committed in xterm, so only that unfinished
ESC is carried, avoiding duplicate image placement when ST itself is split. Over-limit
strings retain an ignored control-string state, never a suffix that could become a new image.
The initial parser is held until the addon's asynchronous WASM decoder is ready.
An unfinished Sixel snapshots its pre-command palette and modes, because replaying an earlier
pixel prefix against a palette changed later in that same DCS would recolor it. When an
over-limit prefix is deliberately omitted, the current palette is retained instead.

Protocol **26** is a dedicated compatibility commit. The envelope remains opaque VT data,
not a new frame field, but pre-image browser parsers ignore image cursor effects and would
misplace subsequent text. Session negotiation therefore refuses old browsers through the
existing protocol-skew UI. Machine and instance frames are unchanged, so their compatibility
sets add 26 without disconnecting older spokes. An updated terminal host is required:
replacing a transport or web bundle does not upgrade a retained host. This decision authorizes
neither production/fleet activation nor restarting live workloads; upgrade a target hub
before installing a newer-protocol transport.

## Resource policy

Each mirror and viewer uses the same stream-local FIFO admission: at most **64 images**,
**2,097,152 decoded source pixels**, **2,048 canonical cells**, and **180,000 encoded bytes**.
Sixel RGBA uses deterministic lossless palette plus PackBits packets, preserving up to256
colors plus transparent fill; arbitrary RGBA uses lossless literal/repeated-color packets or
raw bytes, never quantization. PNG/JPEG/GIF retain their original inline encoded bytes.
Both live parsers compute the same encoded admission charge. Every packet, count, palette
index and exact pixel count is validated before bounded RGBA allocation. The codec is a small
neutral binary grammar in the existing protocol pillar; no additional dependency is needed.
An image exceeding its pixel, cell, input or encoded budget is refused with a named browser
notice, not silently represented as a successful display. Admitting a new image evicts oldest
cached images on every peer, including still-visible ones. The Sixel palette is limited to256
entries. Sixel input and iTerm decoded input each retain a **131,072 byte** ceiling. Browser
decoding also checks original raster dimensions before allocation.
The streaming iTerm header is capped at 4,096 characters before upstream field parsing.
Live admission and snapshot validation use the same byte-level raster-header predicate,
including unsigned PNG dimensions and JPEG segment bounds. Sixel's rectangular output extent
is checked before reading the decoder's RGBA expansion, not merely after image allocation:
sparse encoded bands can otherwise expand far beyond their packed allocation.
The unfinished-control tracker is capped at 180,000 characters; over-limit commands remain
ignored through their terminator.

Cache lifetime deliberately does not use a browser's scrollback markers. A snapshot may omit
old text rows, so marker-driven cache eviction would otherwise differ between an established
viewer and a new one. Text erasure and scrolling still remove visible image cells; bounded
backing raster data remains until FIFO eviction, reset, alternate-buffer retirement or
terminal disposal. Snapshots include this cache's admission state even for images without
remaining visible cells. No bytes enter SQLite, scene state, localStorage or disk.
The addon's mutable tile counter is replaced with the admitted canonical footprint, so
repeated shrink/grow and omitted scrollback cannot cause either counter overflow or
viewer-dependent early eviction. Deleting a cached image refreshes the entire visible image
layer, not just the row where its replacement was painted. Per-cell placement records retain
the exact source tile through reflow, and drawing handles multiple source rows on one terminal row.

The graphics envelope reserves at most **267,000 UTF-8 bytes** within the existing snapshot
ceiling. Compact placements occupy at most16,384 base64 characters and encoded image payloads
at most240,000 plus individual padding; a conservative full-envelope bound is265,083 bytes.
The267,000 envelope cap plus180,000 pending-control cap leaves room for mode, marker and text
within the existing449,992-byte payload budget. Text history is reduced before either graphics
or continuation is dropped. The
existing explicitly marked pathological-current-screen truncation retains its text omission
behavior and omits cell placements rather than painting them onto shifted text rows, while
preserving bounded cache/protocol state. Ordinary retained images are not silently lost only
on reconnect.

## Maintenance boundary and alternatives

This is an intentional pinned private seam: addon storage, renderer dimensions/draw and
protocol handlers, plus xterm's image-cell attributes. Runtime shape guards fail explicitly
on an incompatible addon. Upgrades must exercise live images, late viewers, partial DCS/OSC,
Sixel palette continuation, erasure, scrolling, alternate buffers, resize and fractional font
metrics before changing either pin. The neutral snapshot schema and numeric image budget live
with the already-admitted protocol pillar; they import no renderer, browser, plugin or xterm
implementation. Renderer policy and the addon-specific adapters remain with their consumers.

Rejected: addon-only rendering (late attach loses images); replaying a bounded byte tail
(neither a complete screen nor a parser state); inventing a graphics decoder/engine; native
canvas dependencies in every agent binary; changing terminal identity to induce unsupported
OMP behavior; storing image attachments as a substitute for terminal rendering.

## Verification boundary

Direct runtime smoke exercises a real new Bun PTY with `NO_COLOR=1`, proves truecolor is
advertised without removing the opt-out, receives the authoritative XTSMGRAPHICS reply,
decodes a Sixel image into a snapshot cell and preserves following text. A separate real-PTY
snapshot race captures sequence 1 inside a DCS, queues completion as sequence 2, and observes
an unfinished prefix/no image at sequence 1 and one image at sequence 2. Focused regression
cases cover these boundaries, erasure, scroll/resize, FIFO eviction, reset and invalid raster
headers. Main integration owns builds, test execution and actual browser/OMP visual proof;
these smoke results alone are not that proof.

A real PTY also runs the installed OMP source's `TUI`, `ProcessTerminal` and `Image` consumer,
with a700x280 PNG and ordinary100-column/20-row image constraints. Its actual startup probe
selects Sixel automatically and receives7x14 cells; its production encoder emits690x276
pixels (height rounded to Sixel bands), retained losslessly as6,333 encoded bytes and1,980
cells in a25,983-byte snapshot. No protocol override or emulator identity is injected.
Exact packet roundtrips additionally cover193,200 pixels with256 colors plus transparent
fill and arbitrary RGBA without quantization. These are source-consumer/runtime proofs,
not a claim that bare OMP's separate clipboard-extension lifecycle issue is fixed.
