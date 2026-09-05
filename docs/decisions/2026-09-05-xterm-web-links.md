# Use xterm's maintained web-link provider for terminal URLs

Date: 2026-09-05
Status: accepted

## Context

The terminal interaction work in #281 / draft PR #292 adds modifier-click URL activation.
URLs can wrap across terminal rows, follow wide or combining characters, and coexist with
OSC 8 links. A DOM-text regex would duplicate terminal buffer-to-cell coordinate mapping
and would be wrong at exactly those boundaries.

## Decision

Pin `@xterm/addon-web-links` **0.12.0** in `@manifold-plugin/terminals`, alongside the
existing `@xterm/xterm` **6.0.0**. This is the official MIT-licensed xterm addon, with no
runtime dependencies, released from the same upstream version family. Its public contract
requires xterm v4 or later. Use the addon unchanged: no custom regular expression, no
parallel URL recognizer and no private xterm APIs.

Plain links and xterm's existing OSC 8 `linkHandler` share one activation callback:
Ctrl-left-click (also Cmd-left-click on macOS), absolute HTTP(S) targets only, and a new
window with `noopener,noreferrer`. Keep OSC 8's `allowNonHttpProtocols` false. Ordinary
selection and clicking never navigate.

## Why this is boring, small and pinned

The shipped `WebLinkProvider` reads wrapped buffer lines and maps string indices back
through cell widths, including early-wrapped wide characters. Its expansion is bounded
at whitespace and approximately 2048 characters above/below the requested line; this is
the upstream detection limit, not a new parser we maintain. xterm's OSC provider already
tracks explicit hyperlink cell attributes and filters protocols. The addon supplies only
the missing plain-URL provider, while application policy stays in one small gesture helper.

A handwritten recognizer would save a small package but make this repository responsible
for terminal wrapping, Unicode cell mapping and URL boundary fixes. Exact pinning keeps
upgrades deliberate, and removing the addon requires changing only the terminal plugin.

## Evidence

- [Published package metadata](https://registry.npmjs.org/@xterm/addon-web-links/0.12.0)
- Installed addon source: `src/WebLinkProvider.ts`, `LinkComputer.computeLink`,
  `_getWindowedLineStrings`, and `_mapStrIdx`.
- Installed xterm 6 source: `src/browser/OscLinkProvider.ts` and
  `src/browser/services/SelectionService.ts` (completed selection change on mouseup).

The existing dated dependency records are unnumbered; open PR #183 claims no decision
record. This record does not allocate or collide with a numbered architecture decision.
