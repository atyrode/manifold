# 0001 — Runtime and dependency pins (2026-08-24)

## Decision

TypeScript everywhere; **Bun 1.3.13** (nixpkgs) as runtime for server, agent, tooling,
tests. SQLite via `bun:sqlite`. WebSockets + pub/sub via `Bun.serve`. PTYs via
`Bun.Terminal` (shipped in Bun 1.3.5). Node 24.15 remains the documented fallback runtime
for the agent package only (node:sqlite and native TS stripping verified present) should
`Bun.Terminal` regress; node-pty would then need a nix toolchain (gcc/make not in profile).

## Evidence (this machine)

- `Bun.Terminal` functional matrix ×5: bidirectional echo, UTF-8 multibyte (你好🚀), ANSI,
  resize→SIGWINCH (`stty size` = `40 120`), exit code propagation (3), close-while-alive →
  child SIGHUP (129). Backpressure: 688,990 bytes through the PTY in ~50ms, byte-identical
  across 3 runs, complete delivery. Scripts: `docs/spikes/s2-pty.ts`, `docs/spikes/s2-pty-backpressure.ts`.
- Canary build: `@excalidraw/excalidraw 0.18.1` + React 19.2.8 + `@xterm/xterm` 6.0.0 under
  Vite 8.2.2 → `vite build` green (1.82MB main chunk; code-splitting is a web task).
- `tsc -b` green across workspace with strict + exactOptionalPropertyTypes +
  noUncheckedIndexedAccess.

## Pins and deliberate non-latest choices

| Dep                    | Pin                                                          | Note                                                                         |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| bun                    | 1.3.13                                                       | nixpkgs; `Bun.Terminal` validated on this exact version                      |
| @excalidraw/excalidraw | 0.18.1 exact                                                 | latest stable, MIT; upstream master unreleased                               |
| react/react-dom        | 19.2.8 exact                                                 | excalidraw peer ^19 satisfied                                                |
| @xterm/*               | 6.0.0 / fit 0.11.0 / serialize 0.14.0 / headless 6.0.0 exact | current stable line                                                          |
| zod                    | 4.4.3 exact                                                  | protocol source of truth                                                     |
| vite                   | ^8.2.2                                                       | rolldown-based; canary-proven                                                |
| typescript             | ^5.9.3                                                       | **not** 7.0.x: native-compiler line too new for typescript-eslint 8; revisit |
| eslint                 | ^9.39 + typescript-eslint ^8.68                              | **not** eslint 10: pairing with typescript-eslint 8 is the certified combo   |

## Rationale

One language end-to-end keeps a single typegraph: `@manifold/protocol` types are imported
by client, server, agent, SDK, and tests, so a wire change is compiler-checked everywhere,
and the identical reconcile module runs on both sides of the network. Bun built-ins remove
~5 dependencies (ws, better-sqlite3, node-pty, tsx, test runner). "Latest" was treated as a
selection criterion, not a mandate — see non-latest choices above.
