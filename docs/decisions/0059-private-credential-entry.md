# Host-owned private credential entry and sealed native enrollment

Date: 2026-10-02
Status: accepted

## Problem

Service consumers name a declared credential reference; the native owner holds the private
file and injects its value. External file provisioning is the only enrollment path. Sending
a value through service configuration, a plugin panel or an ordinary hub request would put
plaintext in a trust domain that must never receive it. An in-realm plugin panel shares the
browser document and is not a secret-entry boundary.

The narrow host-owned private-entry exception is ratified in
[#768](https://github.com/atyrode/manifold/issues/768#issuecomment-5943059768).
It is not a general host-owned service management interface or a new default plugin seat.

## Decision

Plugin management exposes declared machine/reference/origin/availability metadata and an
operator control opening a separate host-only document. That document loads no plugin code
and retains the normal discovered action ladder and portable browser baseline. It seals
bytes directly to the current proved native owner's enrollment key. The hub receives only
ciphertext, safe enrollment metadata and named status; plugin code receives no credential
value, value accessor or secret-request method. The existing service credential-reference
indirection and local private-file consumption remain authoritative.

Use **`@hpke/core` 1.9.0**, MIT, with lockfile-pinned `@hpke/common` 1.10.1, rather than
implementing ECDH, HKDF or authenticated encryption. The suite is RFC 9180 DHKEM(P-256,
HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. The original browser and native owner both use
WebCrypto. The recipient is generated as a nonextractable key pair and stays memory-only
for one owner incarnation; its public metadata is part of the existing signed owner proof,
separate from the durable Ed25519 owner identity. Mutable resource announcements cannot
replace that proof's encryption key.

The shared protocol owns strict envelope/context schemas, size bounds and the one
cryptographic mechanism. Its maintained library is imported lazily: ordinary principals
that do not enroll credentials do not initialize HPKE. Move the existing binary-safe SDK
base64 implementation into that shared package, migrating private imports and retaining
the intentionally public SDK exports. There is no duplicate codec or obsolete private
SDK module.

Authenticated context binds the format/suite/key, exact machine, proved owner identity and
generation, declared reference and origin, one single-use nonce and expiry, and explicit
replacement intent with a non-secret source revision. The native owner admits only a
declared source under retained directory capabilities. Missing declared leaves can be
initially enrolled; unsafe or non-publishable parents do not gain an alternate ambient
store. Explicit replacement atomically publishes a private file and switches every held
resolver to its new descriptor before retiring the old one. Malformed/decryption errors
are closed named refusals, not library exception text or plaintext-bearing diagnostics.

The living boundaries belong to [Data and credential boundaries](../CONTRACTS.md#data-and-credential-boundaries),
[Host services](../PLUGINS.md#6-host-services) and the floor/device-local inventories in
[REGISTRY.md](../../REGISTRY.md). Constitutional admission belongs to
[Foundation law](../../AXIOMS.md#foundation-law); the ratified exception does not authorize
another host-owned feature surface.

## Dependency evidence and limits

The pinned primary source is
[hpke-js commit f9fbe3d5](https://github.com/dajiaji/hpke-js/tree/f9fbe3d5a6404f516df859e472c078c0d08e8057),
with [published package metadata](https://www.npmjs.com/package/@hpke/core/v/1.9.0).
The upstream does **not** claim a formal security audit. RFC/vector or Wycheproof coverage
is not represented as an audit.

A disposable Bun 1.4.2 recipient recovered a 16,384-byte synthetic value using its complete
nonextractable key pair. Private-key export refused; changed authenticated context, changed
ciphertext and a rotated key each refused. Actual Chromium 148 sealed the same bounded value
to Bun with a 65-byte encapsulated key and 16,400-byte ciphertext. Repository Vite 8.2.2
bundled the sender to 30,222 bytes / 8,436 gzip bytes, and that exact bundle passed browser
to native interoperability. Its old-Node `crypto` compatibility fallback was externalized;
the browser path used native WebCrypto. A generic Bun browser build retained compatibility
polyfills at 557,954 / 165,701 gzip bytes and is not the production bundle-cost evidence.
The isolated package, bundles, scripts, browser and loopback server were removed after proof.

These are prerequisite crypto/bundle receipts, not proof of the finished authority, browser
isolation, hub/plugin plaintext exclusion, file replacement or nonce lifecycle. Complete
integration must exercise those original acceptance boundaries with synthetic data only.

## Alternatives

- **A plugin value field or policy-writing door:** rejected; the plugin and hub would receive
  plaintext, and configuration authority does not grant secret-upload semantics.
- **A host React component in the existing plugin document:** rejected; DOM/process sharing
  provides no secret-entry boundary against another in-realm row.
- **A second browser-to-agent transport:** rejected; the proved-owner relay already exists,
  while an additional transport adds authentication, interruption and deployment obligations.
- **Hand-written ECDH/HKDF/AES composition:** rejected; protocol-specific binding is necessary,
  a second cryptographic implementation is not.
- **An extractable or durable enrollment private key:** rejected; it unnecessarily expands
  secret persistence and couples encryption rotation to the durable owner signing identity.
- **A new shared package or native dependency on the full scene/session SDK:** rejected; the
  platform-neutral protocol package already owns the context and wire vocabulary, and lazy
  WebCrypto-based crypto introduces neither another package nor a scene dependency.

## Floor admission

The envelope schema, lazy cryptographic mechanism, moved binary codec and shared canonical
authenticated-context encoder join the existing **`protocol`** pillar. The canonical encoder
is extracted from native job signing rather than copied or coupled to job-schema initialization:

- **Bootstrap circularity:** private entry and native custody need the sealed carrier before
  guest code may execute; a plugin cannot supply the boundary excluding itself from plaintext.
- **Neutrality:** inputs are machine, owner, reference, origin and sealed bytes. No provider,
  contributed service, plugin identity or preferred roster appears in the mechanism.
- **Arbitration:** the context distinguishes the proved recipient, target, incarnation and
  single-use admission; a requesting plugin cannot authorize its own credential custody.

## Verification obligations

Prove actual operator interaction in the separate no-plugin document, inspect rendered
screenshots, and exercise the normal root action ladder. Observe ciphertext-only hub
requests/traces/logs and metadata-only plugin interactions. Exercise original credential
withdrawal across awaited native work, exact-machine scope, unproved/offline/unsupported
owners, unknown reference/disallowed origin, format/key/context mutation, nonce replay and
expiry, failed or cancelled enrollment, explicit replacement and source revision conflict.
Use actual disposable native file custody and an existing consumer before and after
replacement; prove restart rotates the enrollment key without changing durable signing
identity, clears transient admissions and does not replay enrollment. No real credential,
provider request, production action or fleet/native activation is implied by these proofs.
