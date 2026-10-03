# Pin the maintained WebGL addon without changing xterm's engine or DOM default

Date: 2026-10-02
Status: accepted

## Decision

For [#878](https://github.com/atyrode/manifold/issues/878), add the official MIT-licensed
`@xterm/addon-webgl` **0.19.0**, exact, to the terminals plugin. Keep `@xterm/xterm`
**6.0.0**, its existing pointer-scaling patch and every PTY, parser, input, history and
terminal-lifetime boundary. WebGL is a renderer of the existing `Terminal`, not another
terminal engine or PTY connection.

DOM remains the default. The addon is dynamically imported only after explicit local,
per-device/per-terminal-id opt-in; aliases of the same terminal share that preference.
Renderer refusal, disabling and context loss must restore DOM on the same terminal,
without reconnecting the PTY or resetting its buffer. This dependency decision does not
itself prove the application integration or native-device performance.

Use the existing [Bun pinned-patch convention](0003-patched-xterm-pointer-scaling.md):
`patches/@xterm%2Faddon-webgl@0.19.0.patch`, recorded in root `patchedDependencies` and
`bun.lock`. Ship the maintained source corrections and **both** real distribution
entrypoints with their source maps. Do not ship a wrapper masquerading as the addon,
patch only the ESM path, or silently select a prerelease engine. Ordinary `bun install`
applies the patch; it does not rebuild an upstream monorepo.

## Published compatibility and provenance

Primary registry metadata read on 2026-10-02:

- [`@xterm/addon-webgl/latest`](https://registry.npmjs.org/@xterm%2faddon-webgl/latest)
  is 0.19.0, with no declared runtime or peer dependencies. Its `main` is
  `lib/addon-webgl.js`, `module` is `lib/addon-webgl.mjs`, and `types` is
  `typings/addon-webgl.d.ts`.
- [The exact addon record](https://registry.npmjs.org/@xterm%2faddon-webgl/0.19.0)
  and [the xterm 6.0.0 record](https://registry.npmjs.org/@xterm%2fxterm/6.0.0)
  share `gitHead`/`commit` **f447274f430fd22513f6adbf9862d19524471c04**.
  The addon's generic “xterm.js v4+” description is not qualification evidence;
  the matching release source, reviewed private renderer seams and the bounded
  consumer qualification below support this particular pair.
- [`@xterm/addon-webgl/beta`](https://registry.npmjs.org/@xterm%2faddon-webgl/beta)
  is 0.20.0-beta.300 and declares `@xterm/xterm: ^6.1.0-beta.304` as a peer.
  It is not an addon-only upgrade compatible with the retained stable engine.

The published addon tarball is
[`addon-webgl-0.19.0.tgz`](https://registry.npmjs.org/@xterm/addon-webgl/-/addon-webgl-0.19.0.tgz).
Its registry integrity, also retained in `bun.lock`, is
`sha512-b3fMOsyLVuCeNJWxolACEUED0vm7qC0cy4wRvf3oURSzDTYVQiGPhTnhWZwIHdvC48Y+oLhvYXnY4XDXPoJo6A==`.
The source base is the official
[pinned addon directory](https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-webgl),
not a moving branch. The package manifest, MIT license and public type declaration
remain unchanged. That declaration exports the real `WebglAddon implements
ITerminalAddon`, its boolean `preserveDrawingBuffer` constructor argument,
`onContextLoss`, `dispose()` and `clearTextureAtlas()` for normal package imports.

## Maintained source backports

The retained, qualified checkout has only these four modified addon TypeScript files:

1. `GlyphRenderer.ts` backports
   [upstream #6042](https://github.com/xtermjs/xterm.js/pull/6042): each renderer tracks
   its own `_lastSeenPageLayoutVersion`, compares it at `beginFrame()` and resets it
   when its atlas changes. A shared atlas cannot let one renderer acknowledge a
   mutation on behalf of every owner.
2. `TextureAtlas.ts` backports #6042's monotonic layout version for page merges and
   overflow-page creation, plus
   [upstream #6055](https://github.com/xtermjs/xterm.js/pull/6055)'s increment after a
   non-empty shared-atlas clear. The existing empty-atlas early return is unchanged.
3. `Types.ts` changes the internal atlas interface from `beginFrame()` to the readonly
   `pageLayoutVersion` used by those owners. No public addon API is changed.
4. `WebglRenderer.ts` backports
   [upstream #6069](https://github.com/xtermjs/xterm.js/pull/6069): after disposing
   render layers, detaching the canvas and removing its atlas-cache ownership,
   teardown calls `getExtension('WEBGL_lose_context')?.loseContext()`.

The upstream source contributions are pinned by their final PR commits:
[#6042: 9559005bbce80f7f7f10c20e9e9983e33c4e9198](https://github.com/xtermjs/xterm.js/commit/9559005bbce80f7f7f10c20e9e9983e33c4e9198),
[#6055: 0b1c0b5c5a9e159a41d326eedbc3bfe0282783d4](https://github.com/xtermjs/xterm.js/commit/0b1c0b5c5a9e159a41d326eedbc3bfe0282783d4)
and [#6069: 89b0b0786136c5c6fce94923a73ff2000e9680e3](https://github.com/xtermjs/xterm.js/commit/89b0b0786136c5c6fce94923a73ff2000e9680e3).

These are backports of the upstream mechanisms to the stable source shape, not a
cherry-pick of unrelated newer-engine code. #6042 and #6055 are merged upstream;
#6069 is still open at this decision date. The source retains its qualified backport
comments and stable API rather than absorbing the newer addon options API. The optional
extension call does not throw when the extension is absent; immediate context retirement
on such an implementation is **not** established by the qualification.

## Local balanced constructor acquisition

The upstream backports do not cover a constructor that throws after acquiring a
context but before registering its final teardown. The
[2026-10-02 failing-before receipt](https://github.com/atyrode/manifold/issues/878#issuecomment-5955462155)
records a real SwiftShader WebGL2 context and shader-compilation refusal: addon
activation threw, public addon disposal returned normally, but one context remained
live and two canvases stayed attached. The retirement extension was available and
the original DOM terminal could still write; usable fallback alone hid the leak.

An additional **local**, not upstream, delta in `WebglRenderer.ts` balances that
acquisition boundary:

- Initialize layer ownership before acquisition, and push each completed layer into
  the same array rather than allocating a second array.
- Register cursor-blink ownership and final teardown before fallible initialization.
  Teardown tolerates a not-yet-created canvas/context and cancels restoration timers.
- Guard constructor initialization, dispose acquired ownership on refusal and rethrow
  the original initialization error. The addon installs its renderer only after this
  constructor returns, so the existing DOM renderer is not replaced on failure.
- Retire the acquired context as part of teardown, including GL resources allocated
  by a child renderer constructor that never returned an object to its caller.

The [passing-after ESM receipt](https://github.com/atyrode/manifold/issues/878#issuecomment-5955507476)
records the identical acquired-context shader refusal: the context was immediately
lost, public addon disposal completed, zero canvases remained and the original DOM
terminal visibly rendered the post-refusal witness. This is a separate disposable
software-renderer proof of the local guard, not native performance or packaged
application qualification.

Before this local delta, the retained `WebglRenderer.ts` SHA-256 was
`0dc6b24c9d9540b264ca06675f7bb256cb64d47de3a6770fefc891f397d76927`.
The final source hash below distinguishes the guard from the upstream backports.

## Recorded package bytes

The first three source files remain byte-identical to the retained maintained
checkout. `WebglRenderer.ts` additionally contains the local acquisition guard.
After all source changes, the official pinned TypeScript, production UMD and
production ESM recipes were run once in an independent source checkout to regenerate
both entrypoints and their maps. The original retained qualification checkout was
not modified. The committed patch has SHA-256
`6bc3b1ac907826d9966cd7a03a3a6c3ed23991baa1eb68d47a2379b11ba8fe42`.
After Bun applies it, paths relative to the addon package have these SHA-256 values:

| Package path              | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `src/GlyphRenderer.ts`    | `c3df1ca7bc1af3f62c8d0e221dc61a4236b52ea1611da4ff6f0a6a52c747aed9` |
| `src/TextureAtlas.ts`     | `b4b6e0752a9efbd28116aa8d7a7d06086747cefa11d842e6369e3d34d23aea56` |
| `src/Types.ts`            | `33d541d1bd31e4761e36c9334711699e82f4fb23d9597ec333571e72c3fa2a04` |
| `src/WebglRenderer.ts`    | `82dcbd33c2a7d9912e814651b7adf437dbfb6c8bad23d2bfcb5554a13c8c88ea` |
| `lib/addon-webgl.js`      | `6eccbd6313352c3efbaa4896381de418def0725916850c644708d3a9e03c238c` |
| `lib/addon-webgl.js.map`  | `c859a853e3ebc0ec87f4d5e883fe0e0f8725bdbf81e50a185f3249b24cb7c28b` |
| `lib/addon-webgl.mjs`     | `ec72497ae4abe754725a4154ab86a8be1c7d85b3f517efa633cfcead547a27a1` |
| `lib/addon-webgl.mjs.map` | `1b00a086bda948c808dbbc174ddadf41a9b329fa8b72d2838ae08e6a44a69d68` |

## Packaging and reproduction

The packaging change uses **Bun 1.4.2** through its supported workflow:

```sh
bun add --exact --ignore-scripts --filter @manifold-plugin/terminals @xterm/addon-webgl@0.19.0
bun patch --ignore-scripts @xterm/addon-webgl@0.19.0
# Replace the four src files and four lib files in the prepared package
# with the maintained source and real generated outputs identified above.
bun patch --commit node_modules/@xterm/addon-webgl --ignore-scripts
```

The core xterm patch remains independently wired at
`patches/@xterm%2Fxterm@6.0.0.patch`. The wheel-preflight correction below extends its
existing pointer-scaling fix; the combined patch SHA-256 is
`c9aa03796108e7d853772bdcbae98ee7afe962bed3869dd266e02b1f9ea4e9b2`.
No Bun runtime pin changes are needed. Because dependency inputs changed, the Nix
vendored-dependency fixed-output hash must be regenerated by the integration owner;
this source packaging decision does not manufacture that hash.

For source regeneration, use an independent official xterm checkout at the pinned
commit, outside any fixture's dependency ancestry. Copy the four maintained source
files from the patched package into `addons/addon-webgl/src/`. The pinned upstream
`package-lock.json` supplies the build resolutions (TypeScript 5.5.3, Webpack 5.94.0,
webpack-cli 4.10.0, source-map-loader 3.0.2 and esbuild 0.25.2). Bun can migrate that
lockfile during normal installation. Final artifact generation reused the retained
Bun lock with SHA-256
`ca69119a3dda84fa39d82a6f9d8e949fea218f97fed5fef328c6406736636525`,
installed via `bun install --frozen-lockfile --ignore-scripts`. The unchanged upstream
`package-lock.json` has SHA-256
`be3cc17b035f88119b89a71e5c3c656bac0edcd6f9494a1393d8aef3e17b7688`.
On Linux x64, the qualification installed the missing esbuild platform package
through the normal exact package flow:

```sh
# From the independent pinned xterm checkout, with all four maintained source files:
bun install --ignore-scripts
bun add --dev --exact --ignore-scripts @esbuild/linux-x64@0.25.2
bun node_modules/typescript/bin/tsc -b tsconfig.all.json
# From addons/addon-webgl, use its unchanged production UMD configuration:
bun ../../node_modules/webpack-cli/bin/cli.js --config webpack.config.js
# From the xterm checkout root, use its unchanged production ESM recipe:
bun bin/esbuild.mjs --prod --addon=webgl
```

The generated `lib/addon-webgl.js` is the official Webpack UMD entrypoint, including
CommonJS consumers; `lib/addon-webgl.mjs` is the official esbuild ESM entrypoint used
by module-aware browser bundlers. Each keeps its corresponding generated source map.
The retained upstream-backport candidates, not an ad-hoc generated substitute, were
qualified separately for both formats. The local guard is built into both formats;
its ESM refusal proof is recorded above. Packaged application, current UMD consumer
and repeated atlas/churn qualification remain the integration owner's separate
evidence obligation, not a claim inherited from older outputs. Source regeneration
must retain the pinned build inputs and repeat consumer qualification before
replacing the recorded bytes; changing just one bundle is not acceptable.

## Local wheel-preflight correction

Canvas pinch remains canvas input, including over a focused terminal with populated
scrollback. `TerminalView` uses xterm's public `attachCustomWheelEventHandler` to
decline Ctrl-wheel before opening the terminal; ordinary wheel input is unchanged.
The stable engine's autonomous `SmoothScrollableElement` previously consumed those
events below the public callback, and its mouse-protocol listener cancelled events
even when that callback declined them. A terminal-root capture shim would leave
those competing owners intact.

This is a **local** correction against the same
[6.0.0 source](https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04),
not an upstream backport. Inspection of
[upstream c58ea363](https://github.com/xtermjs/xterm.js/tree/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2)
did not find a maintained correction to that boundary:

- `CoreBrowserTerminal.ts` runs the public wheel callback once before scrolling,
  mouse reporting or cancellation. A declined event remains available to its parent.
- `Viewport.ts` disables only the scrolling element's autonomous wheel listener.
  Accepted events targeting that viewport use its existing delegated scrolling
  engine; no second scroll implementation or application access to private fields
  is introduced.
- The original `Mouse.ts` pointer-scaling correction, terminal engine version and
  the independently recorded WebGL addon patch remain unchanged.

Both core distribution formats and their maps were regenerated from these same
three source files with TypeScript5.5.3, Webpack5.94.0 and esbuild0.25.2, using the
official browser TypeScript, root Webpack and `bin/esbuild.mjs --prod` recipes.
All six changed-source/map comparisons matched exactly.

| Core package path   | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `lib/xterm.js`      | `ae1c5f01f283494afe2d357db4446578d93ccdfb49f9e0014e42d08b882d49db` |
| `lib/xterm.js.map`  | `5c3adc4dd424c7783efc14047f2f993ccc55bff647579f737bfaba3c2b604825` |
| `lib/xterm.mjs`     | `71648c40ee5c16c586274e881c1ad230e069ff195e9567d05af29f02a6d6ce36` |
| `lib/xterm.mjs.map` | `52a907f930e723e6ef71e1e3192814bcc643b0ac445b4fc2d32401655df79b21` |

A real Chromium consumer exercised26 UMD/ESM wheel scenarios: normal and alternate
buffers, mouse reporting, absent/accepting/declining callbacks, explicit prevention
and target scoping. Declined events reached the outer owner without scrolling
history or emitting PTY data. This library proof is not a substitute for the
application's focused DOM/WebGL pinch, ordinary-scrollback and scaled-selection
proof, or for native-device qualification.

## Alternatives and evidence boundary

- **Unmodified stable 0.19.0:** rejected. The
  [initial 2026-09-30 receipt](https://github.com/atyrode/manifold/issues/878#issuecomment-5919575006)
  records 12,529 changed witness image channels (maximum difference 237) after another
  terminal cleared and repopulated the shared atlas, despite an unchanged witness
  buffer. All 24 disposed addon contexts remained live immediately; both mounted
  witnesses were later lost and blank. Stable publication alone is not qualification.
- **0.20 beta / a 6.1 beta engine upgrade:** rejected for this change. It requires a
  different engine peer and widens parser, addon and input compatibility work instead
  of addressing the existing renderer's bounded defects.
- **Another terminal engine or a custom WebGL renderer:** rejected for this change.
  The requested opt-in concerns rendering the existing xterm terminal. Replacing its
  parser, buffer, selection, input or addon contracts is a separate engine decision;
  hand-rolling atlas and GL lifecycle ownership duplicates the maintained implementation.
- **DOM only:** remains the default and fallback, but cannot provide the explicit
  accelerated-renderer choice. It is not removed or made conditional on GPU availability.

The [maintained-source receipt](https://github.com/atyrode/manifold/issues/878#issuecomment-5920735268)
records Linux HeadlessChrome 148 with actual ANGLE/Vulkan SwiftShader, a 1440×900 viewport
at DPR 1, fully on-screen witnesses and a blue-header raster assertion before mutation.
The untouched witness buffer and image were unchanged (zero differing channels,
maximum difference zero); all 24 churn contexts were immediately lost after disposal,
and both live witnesses stayed intact. The
[official-entrypoint receipt](https://github.com/atyrode/manifold/issues/878#issuecomment-5920958621)
records separate production UMD and ESM builds and the same visible consumer result
for each. The owned browser/server and all 26 views/contexts were retired after each run.
These are retained prior receipts, not newly run proofs from this packaging change.

This establishes only the qualified stable candidate's software-rendered atlas and
context-lifetime boundary. It does **not** establish native Mac/PC GPU performance,
CJK/font/IME/accessibility breadth or this application's opt-in, forced-loss and
initialization-refusal integration. The native-device test card and operational handoff
remain separate from dependency packaging. Revisit the patch on any engine/addon pin
change, a compatible released upstream fix, renderer-seam drift or native qualification
that contradicts this bounded evidence.
