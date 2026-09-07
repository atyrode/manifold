# Terminal private modes and native clipboard custody

Date: 2026-09-07
Status: accepted

Operator-directed OMP clipboard compatibility, tracked in #371.

## Problem

A remote TUI cannot read the browser's native clipboard by reading its machine's clipboard.
OMP already has a native terminal protocol: it enables DEC private mode 5522 and consumes OSC
5522 MIME paste exchanges. It copies UTF-8 text through OSC 52. Reimplementing its editor,
turning images into shared files, or adding a local clipboard proxy would create another path
beside that existing contract.

The headless xterm serializer does not retain an unknown private mode. A viewer mounted after
OMP startup therefore loses the mode unless the authoritative snapshot carries it. Browser
clipboard access also cannot be inferred from terminal output: a user gesture and that
browser's permission are prerequisites, and the same principal may control a terminal while
watching it from more than one device.

## Decision

Keep browser clipboard behavior inside the existing `core.terminals` plugin. A trusted paste
captures the representations the browser actually supplies. Enhanced Ctrl+Shift+V reads the
full Clipboard API representation because Chromium's ordinary Ctrl+Shift+V edit command
strips image formats. Native paste events and the opted-in right-click gesture converge on
one exchange. With enhanced mode off, ordinary text remains xterm paste.

A paste authorizes one bounded, expiring, view-local MIME exchange, never a subsequent ambient
clipboard read. The terminal application chooses from the advertised captured representations.
Only the view that issued the grant answers or refuses its request; other views cannot race to
refuse it. Clipboard bytes and grants are memory-only, disposed at lifecycle and authority
boundaries, and approved paste travels through the existing controller-authorized SDK input
channel. OSC 52 text copy requires a separate explicit approval in the terminal view. Queries
never read the browser clipboard; generic MIME writes are refused.

The compatibility reference is OMP v18.1.12 at
`4f429faef639d182633d1cb3f6a15254adcf25c1`, unchanged for clipboard behavior at v18.1.13
`a1b254047d12e143b7c6011536e918c6c35c5906`. Its supported priority is PNG, JPEG, WebP, GIF,
then plain text. OMP retains ownership of focused-input routing, modal image refusal, pending
attachment handling and submission. No shared storage, remote upload, durable download URL,
HTML conversion, arbitrary file attachment or automatic command execution is added (#370).

The mirror and live viewer share `trackTerminalPrivateMode` from `@manifold/protocol`.
It observes a numbered DEC mode without consuming xterm's other handlers, resets on RIS,
and serializes its current set/reset sequence. The agent appends mode 5522 at the snapshot's
existing sequence watermark, reserving its bytes inside the existing snapshot bound. An
unknown mode is not recovered by scanning arbitrary chunks or copying a browser-local flag.

Protocol version remains **25**: session and machine frame schemas are unchanged, and these
are the same opaque VT bytes that an application could already emit. Old browsers ignore the
unknown CSI sequence; old agents omit the suffix, retaining their previous mode-off behavior
after reattachment. Snapshot restoration requires the updated terminal-host code. There is no
new frame, handshake, capability-query requirement or coordinated fleet upgrade authorization.

## Foundation admission: joining the existing protocol pillar

This adds a parser seam to the existing protocol pillar, not a clipboard pillar or a plugin seat.
The pillar inventory is amended in the same change.

1. **Bootstrap circularity.** The authoritative transport mirror must retain byte-stream state
   before any viewer plugin attaches, and while no viewer is mounted. A viewer-owned parser
   could not reconstruct an earlier mode transition for the first snapshot. The common grammar
   therefore belongs with the protocol consumed by that already-admitted transport mechanism,
   not inside the optional browser renderer.
2. **Neutrality.** The shared module has no OMP, clipboard, browser, plugin identity or xterm
   dependency. It takes a numbered DEC mode and a minimal structural parser seam; replacing
   every renderer leaves the same byte grammar and snapshot interpretation. Which mode is used
   and what browser behavior it enables remain consumer policy outside this seam.
3. **Arbitration.** The existing protocol pillar is the single interpretation against which
   independent stream producers, authoritative mirrors and renderer plugins are measured. This
   seam keeps snapshot and live-mode interpretation identical, and deliberately leaves other
   registered mode handlers in control of their own state. Neither a viewer's local lifetime
   nor its choice of parser may override the authoritative stream watermark.

## Alternatives rejected

- **Browser-only mode tracking:** works until navigation or reconnect, because the original
  enable sequence is already gone.
- **Agent and browser parsers maintained separately:** two definitions of the same stream
  interpretation, including split frames, mixed-mode sequences and reset behavior.
- **New clipboard messages or a remote-host clipboard helper:** duplicates an existing terminal
  protocol and adds an authority boundary that the actual OMP consumer does not require.
- **Generic OSC 5522 clipboard writing:** OMP does not use it; retaining write chunks, aliases
  and unsupported binary clipboard-copy behavior would enlarge the security surface for no
  requested consumer.

## Evidence

The agent regression replays a mode-bearing snapshot into a fresh terminal while a later reset
is already queued, proving mode state is captured at the same watermark and built-in bracketed
paste remains intact. Clipboard regressions cover exact UTF-8/binary chunk transfer, one-use
grants, other-viewer non-interference, stale authority and preferences, expiry, overlapping
pastes, old/new request dialects, explicit copy approval and browser denial.

A real Chromium session running installed OMP v18.1.13 receives native browser PNG and text,
chooses PNG over accompanying text, and stages attachments without submission. Its actual OSC
52 copy leaves the browser clipboard unchanged until approval, then copies the native prompt.
JPEG, WebP and GIF use explicitly synthetic Clipboard API ingress with real browser gestures,
transport and OMP decoding: this Chromium only supports writing PNG to its native image
clipboard. These compatibility fixtures are not evidence of native OS support for the other
three formats. Real attachment and consent screenshots are visually inspected.
