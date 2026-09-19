# 0048 — CSP belongs to the hardened browser compartment

Date: 2026-09-19
Status: proposed

## Scope and status

This is the CSP/network-limit design for #391 and #409, not an activated runner or a promise of
network confinement. The shipped behavior is [Browser response policy](../CONTRACTS.md#browser-response-policy)
and [Hardened plugins](../CONTRACTS.md#hardened-plugins): baseline HTTP headers, frame denial,
and a Worker message/DOM boundary that still has ambient networking and origin storage.
[Self-hosting](../SELF-HOST.md#http-response-hardening) specifies the bounded HSTS examples.
No installed artifact, protocol version, persistent instance or live proxy changes under this proposal.

The design preserves ADR 0016's guest-in-a-Worker and host-rendered-UI boundaries. It revisits the
loader's origin and policy, not the accepted in-realm mod model in ADR 0025. The trusted bootstrap
below is not a place to execute guest code or give it a DOM. ADR 0016 remains a historical record;
the living contracts above carry the explicit current limitation.

## Why policy cannot be one shell header

The shell and in-realm plugins are trusted code in one page. An installed web definition is fetched
with an Authorization header, imported from a Blob URL, and may inject its admitted stylesheet.
The page also needs the HTTP and WebSocket origins of a runtime-selected foreign instance. A
server delivering the shell cannot know that instance in advance. A page-wide `connect-src 'self'`
therefore breaks the portable lens; allowing every HTTP/WebSocket origin restores compatibility
but supplies no guest network confinement. A script allowlist with `blob:` likewise does not make
trusted code that can fetch and construct a Blob into untrusted code.

Preview callback and finalize documents are a third, separate surface. Their small inline scripts
complete the identity-nonce-bound handoff under route-specific `default-src 'none'` policies
with `script-src 'unsafe-inline'`; this is not a CSP nonce. Replacing those responses with a
generic shell policy is neither necessary nor safe.

A Blob is a byte-backed URL, not a new security origin. The current loader solves bearer-header
loading without giving the Worker the page's existing bearer or live host objects. It does not
remove browser networking or separate origin storage. A same-origin Worker response carrying
`connect-src 'none'` blocks direct networking, but the experiment below still wrote a CacheStorage
entry that its parent page could read. That is not the origin boundary this design requires.

## Proposed design

### 1. Keep the trusted lens and guest policy separate

Retain the ordinary shell's `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Do not apply a
restrictive script/connect policy to every in-realm mod or dynamically generate a page CSP from an
untrusted `?instance=` value. Existing in-realm authority, Blob imports, inline styles, service
worker behavior and foreign-lens connections remain the trusted-page contract. This deliberately
makes no shell-wide script-injection or in-realm-code confinement claim.

The restrictive script/connect policy belongs to the hardened compartment below. Callback/finalize
HTML keeps its own CSP, `no-referrer` and `no-store`; the normal HTTP wrapper and proxy must preserve
those route choices.

### 2. Use a native opaque-origin factory, then a dedicated Worker

A build-owned same-origin HTML route, proposed as `/plugin-isolate.html`, contains only a small
trusted bootstrap. The host embeds it in an iframe with `sandbox="allow-scripts"`, **without
`allow-same-origin`**. The response also carries `sandbox allow-scripts`; this is an enforced HTTP
CSP directive, not report-only or a meta tag. The resulting factory and its Blob Worker have an
opaque origin, not access to the shell's origin storage. No additional domain, DNS record or TLS
certificate is required.

The factory response policy is:

| Directive                               | Policy                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `default-src`                           | `'none'`                                                                                               |
| `script-src`                            | The SHA-256 hash of the exact build-owned bootstrap, plus `blob:`; no `unsafe-inline` or `unsafe-eval` |
| `connect-src`                           | `'none'`                                                                                               |
| `worker-src`                            | `blob:`                                                                                                |
| `base-uri`, `object-src`, `form-action` | `'none'`                                                                                               |
| `frame-ancestors`                       | `'self'`                                                                                               |
| `sandbox`                               | `allow-scripts` only                                                                                   |

Serve it with JavaScript's bootstrap hash generated from the same bytes as the HTML, the baseline
`nosniff` header, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
`X-Frame-Options: SAMEORIGIN`. Only this route becomes embeddable; neither the shell nor callback
HTML loses frame denial. Static/default proxy policies must not overwrite the factory's response.

The service worker must pass this factory route through unchanged, never store its response as
`/index.html`, and never substitute the cached shell when the factory is unavailable offline.
`Cache-Control: no-store` alone is insufficient: the current navigation handler explicitly writes
successful documents to CacheStorage. Factory failure must remain a failure, not poison or reuse
the offline shell.

The parent fetches the authenticated, admitted bundle through the existing loader. Only after
the policy-readiness check below succeeds does it transfer source bytes and existing init data
through a dedicated `MessageChannel`, never through a URL, inline guest HTML or a
credential-bearing iframe attribute. The bootstrap accepts one channel
from its actual parent; the parent binds the bootstrap handshake to that iframe's `contentWindow`.
An origin string of `"null"` is not authentication: every opaque origin serializes that way. Close
the bootstrap handshake before accepting guest frames. Existing schema validation, host-call
dispatch and the closed UI vocabulary remain authoritative after the transport hop.

Only the trusted bootstrap has an iframe DOM. It creates a **classic** dedicated Worker from the
self-contained guest bytes. Guest code never runs in the iframe or parent. The Blob Worker
inherits the factory's native CSP. HTTP(S) imports, direct requests and network-backed subworkers
cannot escape through a guest-supplied loader. `worker-src blob:` also permits nested Blob Workers;
it is not a no-subworker guarantee. Those descendants inherit the opaque origin and restrictive
policy, which the experiment exercised.

Before receiving guest bytes or init data, the trusted bootstrap must positively verify native
policy enforcement with a bounded, disposable classic Blob Worker canary and its Blob descendant.
Use fixed, non-secret probes to a side-effect-free public endpoint on the serving origin: requests
and script imports must produce matching **enforced** native CSP violations, not merely generic
network/CORS/MIME errors. Verify opaque origin and denied origin-storage access as well. Missing
or report-only policy, absent enforcement observations, timeout and unsupported primitives reject
readiness. A successful handshake or a separate fetch of the expected response headers cannot
attest the policy actually inherited by the Worker. This check is a future runtime prerequisite,
not a replacement for the browser matrix below; it was not integrated into the current runner.

The existing Worker host/registry owns the extra frame and port under the same plugin/container
lease. Disable, final release, identity/lens change and faults must terminate the Worker family,
remove the frame, close ports, revoke object URLs and reject late replies. A missing bootstrap,
policy failure or unsupported browser is an unavailable hardened panel, never an in-realm or
ordinary-Worker fallback. This adds native browser primitives to the existing runner, not a custom
JavaScript evaluator, new package sandbox or new runtime dependency.

### 3. Define destinations by the existing host boundary

The direct guest network destination set is **empty**, including the selected Manifold origin.
The trusted page continues to call that selected instance through its existing `HostServices` /
`SessionHandle`; the guest uses the existing named, schema-checked RPC methods. A foreign instance
therefore does not need to appear in the compartment's CSP and a lens switch cannot accidentally
widen that policy. The init payload still omits the page's bearer and live socket/host handles.

No generic `fetch(url, headers, credentials)` bridge or browser-origin allowlist is added. The
bootstrap cannot request a new destination. Additional external service access must be a separately
reviewed, governed host action, not an arbitrary URL smuggled through a transport method. Existing
navigation remains application history / `manifold://` navigation, not a new external-navigation
bridge. The implementation must retain those boundaries for navigation, streams and redirects as
well as ordinary action calls.

This is a browser ambient-network restriction, **not information-flow control**. Permitted host
calls still have their existing authority and results; actions, `openTerminal` and
`sendTerminalInput` may write shared data or cause external side effects according to their own
contracts. The design does not filter authorized action results, confine server processes or
terminal jobs, impose a browser memory quota, or protect against a
malicious trusted in-realm mod, browser extension or browser exploit.

### 4. Treat classic execution as an executable compatibility change

A module Worker from an opaque-origin Blob failed to start in the tested browser, including with
`credentials: 'omit'`. A self-contained classic bundle worked. Do not claim the existing module
loader can simply move into the iframe unchanged.

The proposed packer uses Bun's existing browser/IIFE target for a hardened web half. Module syntax
and unsupported top-level await must be resolved or refused at pack time, not rewritten with
regular expressions or evaluated through an `unsafe-eval` escape. The server half and trusted
in-realm definitions keep their existing module targets.

Activation requires the existing `hardenedContract` / `repack_required` admission mechanism to mark
this genuine executable break. Old hash-pinned bytes remain retained; they are not rewritten on
load or silently executed with the weaker runner. Plan and prove the resulting installed-bundle
repacking scope through the existing installed-deployment compatibility gate, including any rows
a shared contract-version transition would hold. The browser protocol/compatibility gate must also
reject an old cached lens that would otherwise run the new bytes in its unconfined old loader.
These are required rollout conditions, not version changes made by this design-only delivery.

## Browser evidence

Disposable HTTP instances and native browser primitives were exercised on 2026-09-19 with
Chrome 148.0.7778.215 and Bun 1.4.2. Requests went only to controlled loopback fixtures. Network
sinks counted actual HTTP requests, WebSocket opens, imported modules and network-backed child
scripts; CSP violations and promise rejection were not the only evidence.

| Experiment                                                                                        | Observed result                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current Blob module Worker                                                                        | Controlled `fetch` (including `no-cors`), foreign-instance fetch, WebSocket, module import and network-backed child Worker all succeeded.                                                                                                      |
| Trusted page with `connect-src 'self'`                                                            | Its foreign-instance health request was blocked. This is the incompatible negative control.                                                                                                                                                    |
| Same-origin Worker bootstrap response with default-deny CSP                                       | Direct network channels were blocked, but its CacheStorage write was readable by the parent page. Rejected as the complete boundary.                                                                                                           |
| Opaque factory, classic Blob Worker, actual response CSP                                          | Direct fetch to the sink and foreign instance, WebSocket, remote module import and network-backed child Worker were blocked. CacheStorage and IndexedDB access failed. Sink counters did not increase.                                         |
| Nested Blob Worker in that compartment                                                            | Started successfully; its direct fetch and CacheStorage access were blocked.                                                                                                                                                                   |
| Host relay from that compartment                                                                  | The parent successfully fetched the selected foreign instance while the guest's direct request to it stayed blocked.                                                                                                                           |
| Actual `packages/plugin-kit/test/fixtures/sample/web.ts`, compiled with Bun's browser/IIFE target | The real guest SDK completed init, ready and render; a bump event called `example.counter.bump` on the second real instance through the parent, and the returned count rendered in the guest's next tree.                                      |
| Current application, unchanged shell CSP plus new baseline headers                                | Same-instance and foreign-lens admission, open sessions, authenticated installed in-realm Blob modules and injected CSS worked; both counter buttons changed 0 to 1. The shipped hardened module Worker also rendered and dispatched its bump. |
| Real authority-to-preview browser handoff                                                         | Callback and finalize documents both returned `nosniff`, `no-referrer`, `no-store` and their existing inline-script CSP. The preview reached an open workspace with no query/fragment secret remaining.                                        |

The real counter proof used the proposed HTTP factory response, not only a `srcdoc`/meta-policy
approximation. The browser experiments validate the mechanism and the classic-bundle constraint;
they are not the production Worker registry integrated with that new transport. Actual application
screenshots were inspected separately for same-instance, foreign-lens and preview rendering. Empty
fixture canvases and the existing foreign-lens banner are not evidence of missing network access.

## Conditions before any confinement claim

A future implementation must integrate the proposed route, lifecycle and compatibility transition,
then prove them in the supported browser/deployment matrix before changing the published guarantee:

- Retain positive-control sinks and demonstrate that `no-cors` fetch, XMLHttpRequest/EventSource,
  WebSocket/WebTransport where exposed, `importScripts`, dynamic imports and descendant workers
  cannot send directly; distinguish an unavailable API from a policy denial.
- Prove origin-storage and cross-context channels cannot reach the shell or another plugin, and
  that a late reply, sibling frame or forged bootstrap message cannot acquire the host channel.
- Exercise the real renderer and action/stream path with the selected instance both same-origin
  and foreign; preserve callback/finalize documents and cached/PWA behavior. Prove factory
  navigation cannot overwrite the offline shell or receive it as a fallback.
- Strip or weaken factory CSP and verify the readiness canary rejects execution before any guest
  bytes or init data cross the boundary, including report-only and partial-policy configurations.
- Exercise disable/re-enable, unmount, crashes, identity/lens switches and unsupported-policy
  failure without a weaker fallback or residual Worker family.
- Prove old installed artifacts and old cached clients fail closed with the existing compatibility
  vocabulary, while retained data and the approved repacking/deployment procedure remain usable.

No fetch monkeypatch, report-only header, source review, successful pack or green generic gate
substitutes for that enforcement evidence. Until it exists, the shipped contract continues to say
that hardened Workers have ambient network egress.

## Platform references

- [Worker CSP and Blob inheritance](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#content_security_policy)
- [CSP sandbox and opaque origins](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)
- [ADR 0016: the existing message/Worker boundary](0016-plugin-isolation.md)
- [ADR 0025: trusted in-realm mods](0025-plugins-are-mods.md)
