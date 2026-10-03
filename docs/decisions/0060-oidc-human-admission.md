# 0060 — Configured OIDC admits humans; Manifold keeps its own authority

Date: 2026-10-03
Status: proposed

## Problem and boundary

Manifold authenticates nobody beyond "holds a secret". The owner key is root
(`packages/server/src/auth.ts:853-863`); every other request presents a hashed bearer that is
refused when revoked or expired (`auth.ts:865-884`). A browser obtains its first bearer only from
an explicit `#key=` owner link (`packages/web/src/identity.tsx:137-164`, `:237-254`) or, on a
configured preview, from production's signed handoff (`identity.tsx:53-127`). An unauthenticated
browser on an ordinary instance is told to "open its full pre-authenticated URL"
(`identity.tsx:61-63`). Two humans who share a recovery link are one principal.

[#324](https://github.com/atyrode/manifold/issues/324) selects configured OpenID Connect as the
preferred human sign-in route for multi-human deployments, with external Keycloak as the reference
provider. This record is that issue's **design milestone only**: a proposed architecture, its
security controls, the decisions still owed by the operator and an implementation-ready
acceptance map. It is **not implemented behavior**. No route, configuration, credential or
dependency described here exists in the tree at `c905264c`; current behavior remains normative in
[CONTRACTS §Identity](../CONTRACTS.md#identity-tokens-capabilities) until a ratified slice changes
it. This record authorizes no authentication cutover, dependency addition, provider account,
paid provisioning or production activation, and #324 stays open until delivery.

## Current seams this design must respect

| Seam                                                                                             | What the source does today                                                                                                                                                                                                                                         | Consequence for OIDC                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AuthService.bootstrapPrincipal` (`auth.ts:1912-1936`), published as `core.access.createPrincipal` with `caps: ["*"]` (`packages/plugins/access/src/index.ts:278-284`) | Requires `holdsRoot`, creates a fresh principal, mints a `*` credential and records `principal_bootstrapped`.                                                                                                                                                    | A login placed in front of this door gives every successful login root. Login never calls it. It stays the owner-key recovery door.                                                       |
| `AuthService.acceptPreviewIdentity` (`auth.ts:1943-1979`) behind `/auth/preview/*` (`packages/server/src/http.ts:407-459`, `:890-964`) | After the HTTP boundary verifies an exact-audience, nonce-bound, single-use signed assertion, maps `(issuer, sourcePrincipalId)` deterministically to a local principal with `origin: issuer` and mints an interactive credential carrying the asserted caps. | Precedent for the boundary shape (verified external proof → ordinary principal/grant/token rows, journal events), not for its policy: it trusts production's authority snapshot.            |
| `persistToken` (`auth.ts:1826-1901`) and `applicableRows` (`auth.ts:1726-1750`)                 | A credential's caps become grant rows owned by that token; evaluation sees the principal's untokened rows, its class rows and only this token's own rows. The same flat caps are a ceiling for governed, job and terminal-input paths.                             | A human who signs in on many devices needs a durable record each device credential is minted from, not authority living in one device's token.   |
| `holdsRoot` (`auth.ts:997-1009`, `:1022-1045`)                                                   | Root class is the raw owner key or a live minted `*` token with no deciding administered deny.                                                                                                                                                                       | An administrator's sign-in credential must be minted with `*`; demotion must retire those credentials.                                                                                     |
| `namesPrincipal` (`auth.ts:577-598`)                                                            | An `any-human` row matches every principal of kind `human`.                                                                                                                                                                                                         | Materializing a principal for every authenticated IdP account would silently widen every `any-human` grant.                                                                                |
| Browser custody (`packages/web/src/identity-storage.ts:5-55`, `packages/web/src/api.ts:27-32`)  | The bearer lives in origin `localStorage` and travels as `Authorization: Bearer`; no API door reads cookies (`http.ts:327-340`).                                                                                                                                     | Keep bearer custody; cookies stay non-authoritative transaction state.                                                                                                                     |
| Withdrawal (`auth.ts:4214-4279`, `:4282-4379`; `packages/protocol/src/http.ts:329-332`)         | Pause empties effective authority without revoking; `core.access.revoke` is principal-grouped and requires `tokens:mint`; revocation fences sockets with `4403 revoked` (`packages/server/src/session-ws.ts:277-282`, `:582-609`).                                   | Per-device sign-out and per-session administrator withdrawal need a credential-scoped path.                                                                                               |
| Agent sponsorship (`auth.ts:1240-1254`, `:1446-1500`, `:2687-2698`)                             | An Agent's standing authority is restored from its exact authorizing credential; an expired or revoked sponsor credential restores nothing until the sponsor re-authorizes with `updateAgent`.                                                                     | A browser session ending (sign-out, IdP withdrawal, expiry) withdraws the authority of Agents it authorized. This is existing behavior; OIDC makes session ends more frequent.               |
| Terminal-lifecycle credentials (`auth.ts:3888-3937`)                                             | An independent container-scoped agent principal, revoked when its terminal exits, not when the human's credential ends.                                                                                                                                             | Human sign-out or deprovisioning does not stop work already running in terminals.                                                                                                         |

ADR 0019 §6 placed the relying party "in front of `createPrincipal`". This record reads that as
_in front of principal creation_: the login boundary creates or resolves a least-privilege human
principal through the existing stores, and the root bootstrap door is never on the login path.

## Decision summary

1. **One provider-neutral relying party, off by default.** Configuration names one issuer and one
   confidential client. Without it every current path, including offline single-operator startup,
   is unchanged. No provider name appears in code or configuration keys.
2. **Authorization Code + PKCE `S256` through `openid-client` 6.8.8**, with ID-token signature
   verification enabled and the signing algorithm pinned. No implicit, hybrid or password grant
   and no hand-written OAuth, JWT or cryptography.
3. **Identity is `(iss, sub)`.** One external-identity binding maps it to one local human
   principal. Name, avatar and email are profile, never keys; nothing merges on them.
4. **Authentication is not admission.** An unknown subject receives no principal and no credential;
   its sign-in records one bounded access request. A root actor admits it explicitly, after
   acknowledging the `any-human` rows that will apply. The first administrator is proved with the
   owner key in the same browser transaction; no login ever becomes root by being first.
5. **The browser holds an ordinary Manifold bearer**, one distinct revocable credential per sign-in,
   delivered by a server-rendered callback exactly as the preview handoff delivers one. IdP tokens
   never reach the browser, a URL, a log, a trace, a preview or another instance, and no IdP token
   is ever accepted as a Manifold bearer.
6. **Sessions are bound to the IdP session** (operator decision D1, recommended): the server keeps
   the refresh token and revalidates every 15 minutes; a definitive refusal revokes exactly that
   Manifold credential and fences its sockets.
7. **Workloads stay non-interactive.** Machines, Agents, Runs, runners, native services and
   terminal-lifecycle identities keep their current credential lifecycles.
8. **Previews and remote instances federate Manifold identities, not IdP identities.** The ADR
   0027/0028 handoff is reused unchanged; #412 recipient approval is unchanged.
9. **The owner key remains bootstrap and break-glass.** OIDC failure never falls back to root,
   anonymous access or a cached owner key.

No axiom amendment is required: sign-in is identity admission before a local actor exists, the
precedent ADR 0019 §4 and ADR 0027 already record; every admission change is an ordinary traced
`core.access` door; authority stays the A5 waterfall.

## Trust topology

```text
           human browser (origin = instance public URL)
             │ 1 POST /auth/oidc/start ──► sets __Host- transaction cookie
             │ 2 302 to authorization_endpoint (code, S256 challenge, state, nonce)
             ▼
   ┌───────────────────┐   configured issuer only, HTTPS, exact issuer match
   │ OpenID Provider   │◄──────────────────────────────────────────────┐
   │ (e.g. Keycloak    │   3 code + state + iss to the one registered   │
   │  realm; brokers   │     redirect URI                               │
   │  Google/GitHub)   │                                                │
   └───────────────────┘                                                │
             │                                                          │
             ▼                                                          │
   Manifold instance ── 4 back channel: code + verifier + client secret ─┘
     │  5 validate ID token, resolve (iss, sub) → binding → admission
     │  6 mint ordinary credential (token row + session row), deliver once
     │  7 revalidate refresh token every 15 min (server only)
     ├── production preview handoff (ADR 0027): Manifold principal → preview-local token
     └── instance channel (ADR 0014, #412): host approves guest-origin principal ids
```

An IdP issuer, a Manifold instance origin and a remote instance's principal are three different
trust statements. `Principal.origin` keeps meaning a Manifold instance origin; an OIDC-admitted
principal is local and has no `origin`. A remote instance never learns the issuer or subject, and a
preview never talks to the IdP.

## Configuration and trusted boundaries

| Key                                 | Meaning and validation                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MANIFOLD_OIDC_ISSUER`              | Exact issuer identifier. `https:` only; plain `http:` only for `localhost`, `*.localhost`, `127.0.0.1` or `::1` test fixtures.                                                                                                                                                                   |
| `MANIFOLD_OIDC_CLIENT_ID`           | The confidential client registered for this instance.                                                                                                                                                                                                                                            |
| `MANIFOLD_OIDC_CLIENT_SECRET`       | The client secret, delivered through the process environment like `MANIFOLD_OWNER_KEY` (`packages/server/src/config.ts:107-109`, `:276`); never echoed in errors, logs, traces, `/api/introspect`, `/healthz` or browser responses.                                                         |
| `MANIFOLD_OIDC_LABEL`               | Optional button label (`Continue with …`); display only.                                                                                                                                                                                                                                          |
| `MANIFOLD_OIDC_SCOPES`              | Default `openid profile`; must contain `openid`. `offline_access` is refused, because offline tokens can outlive IdP logout ([Keycloak offline access](https://www.keycloak.org/docs/latest/server_admin/index.html#_offline-access)) and would defeat D1.                                        |
| `MANIFOLD_OIDC_ID_TOKEN_ALG`        | Default `RS256`; one of `RS256`, `PS256`, `ES256`, `EdDSA`. MAC (`HS*`) and `none` are refused.                                                                                                                                                                                                  |
| `MANIFOLD_PUBLIC_URL` (existing)    | Must be explicit when OIDC is configured. The redirect URI is exactly `<public URL>/auth/oidc/callback` and the post-logout URI exactly `<public URL>/auth/oidc/signed-out`; neither is derived from `Host` or `X-Forwarded-*`.                                                                  |

Startup fails closed with a named error when the OIDC keys are partially present, when
`MANIFOLD_PUBLIC_URL` is implicit or non-HTTPS outside the loopback exception, or when OIDC is
configured together with `MANIFOLD_IDENTITY_AUTHORITY`. A process is either an OIDC relying party
or a preview identity consumer (`config.ts:243-248`), so preview tooling cannot inherit a client
secret by accident. Startup does **not** require the IdP to be reachable: discovery is lazy,
cached and retried, so the offline floor and the owner key work while the IdP is down.

Endpoints come only from `<issuer>/.well-known/openid-configuration`, fetched over TLS, whose
`issuer` must equal the configured value
([OpenID Discovery §4.3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationValidation)).
`openid-client`'s `discovery()` enforces that match and HTTPS-only endpoints by default. No request
parameter, callback parameter, ID-token claim or browser value can select a discovery document,
token endpoint, JWKS URI or logout endpoint. There is no dynamic client registration and no
`iss`-driven discovery.

## Sign-in flow and validation controls

1. **Start.** The gate calls `POST /auth/oidc/start` with `{ intent: "sign-in", returnTo }`, or
   with `intent: "link"` or `"link-administrator"` and a bearer (below). `returnTo` is the current
   `pathname + search` only, never the fragment (which may hold `#key=`). It must be a relative
   path beginning with a single `/`, at most 2,048 bytes, without `\`, control characters, a
   scheme, an authority or a `/auth/` or `/api/` prefix; anything else becomes `/`. This is the
   [RFC 9700 §4.11](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.11) open-redirect rule.
2. **Transaction.** The server generates a 256-bit `state`, a 256-bit `nonce` and a PKCE verifier
   (`randomState`, `randomNonce`, `randomPKCECodeVerifier`), stores them server-side under an
   opaque 256-bit transaction id with `returnTo`, intent, link actor and a 10-minute expiry, and
   binds the id to the browser in the `__Host-manifold-oidc` cookie with `HttpOnly`, `Secure`,
   `SameSite=Lax`, `Path=/` and a 600-second `Max-Age`. The cookie carries no authority. The
   `__Host-` prefix forbids a `Domain` attribute
   ([RFC 6265bis](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis#name-the-__host-prefix)),
   so a sibling such as a numbered preview under the production domain cannot toss a cookie into
   production's callback. `SameSite=Lax` still accompanies the provider's top-level `GET` redirect.
3. **Authorization request.** `response_type=code`, query response mode, the exact redirect URI,
   configured scopes, `state`, `nonce`, `code_challenge` and `code_challenge_method=S256`
   ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636),
   [RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1)).
4. **Callback.** `GET /auth/oidc/callback` reads and **deletes** the transaction before any network
   call, so a transaction is single-use. An `error` response renders a cancel/failure page with a
   retry; nothing falls back. Otherwise
   `authorizationCodeGrant(config, currentUrl, checks)` runs with `pkceCodeVerifier`,
   `expectedState`, `expectedNonce` and `idTokenExpected: true`, where `currentUrl` is rebuilt
   from the configured public URL and the received query. The library then:
   - compares `state` exactly and requires the RFC 9207 `iss` parameter to equal the issuer when
     present, and requires it when metadata advertises `authorization_response_iss_parameter_supported`
     ([RFC 9207 §2.4](https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4); observed in
     `oauth4webapi` 3.8.8 `validateAuthResponse`);
   - redeems the code with the verifier and client authentication; the provider refuses replay and
     a wrong verifier (observed below);
   - validates the ID token per
     [OIDC Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation):
     exact `iss`, `aud` containing the client id, `azp` when the audience is multi-valued, `exp`,
     `iat` within the default 30-second tolerance, and the exact `nonce`.
5. **Manifold's additional checks.** `enableNonRepudiationChecks` is on, so the ID token signature
   is verified against the issuer's JWKS with the pinned `id_token_signed_response_alg`; the
   library's default would rely on TLS alone for token-endpoint ID tokens. When `azp` is present it
   must equal the client id even for a single audience. `sub` must be a non-empty string of at most
   255 characters.
6. **Resolution and minting** follow the identity, admission and session sections below.
7. **Delivery.** A `no-store`, `no-referrer`, frame-denied document with the existing callback CSP
   (`http.ts:223-259`) writes the ordinary identity record to `localStorage`, clears the
   transaction cookie and `location.replace`s `returnTo`, removing the code-bearing callback URL
   from history. The code is already consumed and the provider expires unused codes (Keycloak's
   default authorization-code lifespan is 60 seconds, observed below).

**JWKS rotation.** `oauth4webapi` 3.8.8 refetches the JWKS every 300 seconds and, on an unknown
`kid`, refetches only when the cached set is at least 60 seconds old; otherwise the exchange fails
with `OAUTH_KEY_SELECTION_FAILED` (source `getPublicSigKeyFromIssuerJwksUri`; observed below). A
provider that starts signing with a new key immediately therefore costs one failed sign-in within
that minute, with the code already consumed. The failure page offers a retry. The supported
provider procedure is to publish the new key passive first, wait at least five minutes, then make
it active ([OIDC Core §10.1.1](https://openid.net/specs/openid-connect-core-1_0.html#RotateSigKeys)
describes refetching on an unfamiliar `kid`;
[Keycloak passive keys](https://www.keycloak.org/docs/latest/server_admin/index.html#making-keys-passive)).

**Logging.** Library errors are mapped to a closed refusal vocabulary (`sign_in_cancelled`,
`sign_in_expired`, `sign_in_invalid`, `provider_unavailable`, `provider_key_changed`,
`identity_already_linked`, `not_admitted`). Their `cause`, which can contain callback parameters
or response bodies, is never logged. The existing failure log records only method and message
(`http.ts:493-496`); callback query strings are never logged. Journal events carry binding,
principal and token ids, never codes, tokens, refresh tokens, the subject string or a claim set.

## Identity, linking and migration

A new `external_identities` relation stores `{ id, issuer, subject, principalId, linkedAt,
linkedBy, lastSignInAt }` with `UNIQUE(issuer, subject)`. The pair is the only identifier
([OIDC Core §5.7](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability));
`email`, `email_verified`, `name` and `preferred_username` are never looked up, compared or merged.
OIDC proves that the configured issuer authenticated an account under its own policy. It does not
prove a legal identity, employment, trustworthiness or a unique person, and with brokered social
login its assurance is whatever the issuer's linking policy makes it.

A principal admitted through OIDC is `kind: "human"` with no `origin`. Its display name is chosen
by the admitting administrator, prefilled from `name` or `preferred_username`; later profile
changes at the IdP do not rename it. Profile claims are kept only on a pending access request, for
the approver, and deleted when the request is decided.

**Linking an existing principal** is deliberate: one browser transaction proves control, and a
root decision admits.

- **Self-link.** A browser holding a live, unpaused, unscoped credential of a local human principal
  starts with `intent: "link"` and that bearer. The owner principal and remote-origin, preview,
  share-recipient, agent and service principals are refused, as is a principal already bound at
  this issuer. At the callback the server re-checks that the linking credential is still live,
  refuses a subject already bound anywhere (`identity_already_linked`), creates the binding and
  records `external_identity_linked`. Linking confers neither authority nor sign-in: until a root
  actor admits the principal, the subject sees the not-admitted page and the approver sees which
  principal it proved control of. Requiring that decision means a stolen 14-day bearer cannot be
  turned into a durable sign-in for another account.
- **Administrator-asserted link.** When the person has no live credential, a root actor resolves
  their access request onto an existing principal (`core.access.admit` with
  `existingPrincipalId`). The approver's judgment is the proof and is traced.
- **Unlink** is root-only, removes one binding and revokes the credentials minted from it.

Either way the principal id is unchanged, so grants, layouts, ownership tombstones, trace
attribution and presence identity are preserved. Existing owner-key-bootstrapped principals hold
their root in a `*` device token (`auth.ts:1912-1936`), not in principal grants, and authority that
existed only on a device token is never copied. Migrating the operator therefore uses either the
first-administrator link below (a new administrator principal) or self-link followed by an explicit
root `admit` with the template `{ caps: ["*"] }`; other principals get their authority re-expressed
as an admission template, or as grants, by the approver. No migration infers authority from email,
name or the order of sign-ins, and no schema migration creates bindings or admissions.

## Admission, the first administrator and access requests

A new `principal_admissions` relation `{ principalId, template, admittedBy, admittedAt,
revision }` decides whether a bound principal may sign in and what each sign-in credential
carries. `template` is the existing `MintTokenRequest` authority shape, `{ caps, containerId? }`.
Every sign-in mints through `persistToken` exactly the credential the approver could have minted
for that principal with `core.access.mint`: token-owned rows at the anchor, the same flat caps.
This matters because a credential's flat caps are not only rows but also the ceiling several paths
read directly: governed admission (`auth.ts:1360-1369`, `:1673`), job admission
(`packages/server/src/job-service.ts:5354`) and terminal input
(`packages/server/src/terminal-broker.ts:2064`). A capless credential relying on untokened
principal rows would be refused there; a ceiling-only token without rows would contradict A5's
reading that a credential is a grant reference. Administered principal rows keep adding and
denying through the waterfall exactly as they do for minted credentials today.

- An **administrator** admission is the template `{ caps: ["*"] }`, so `holdsRoot` applies with its
  existing deny, pause and expiry rules.
- A **collaborator** on one container is, for example,
  `{ caps: ["containers:read", "scenes:write"], containerId }`; the approver validates the template
  with the existing mint attenuation ladder (`auth.ts:1982-2006`).
- Templates use the V1 shape first. The correlated V2 `scope` shape, which can name several
  containers, follows only after the browser shell is proved with V2-scoped human credentials.

Narrowing or replacing a template, removing an admission or unlinking revokes that principal's
OIDC credentials in the same transaction, fencing their sockets; the next sign-in mints from the
new template. Who may admit is not widened: admission is root-only, as grant administration already
is ([CONTRACTS](../CONTRACTS.md#authority-is-a-waterfall-of-grants-adr-0011-shipped)). Letting
container managers admit people would create the new grant-writing audience that ADR 0011 §8 left
to the identity milestone's deny-attenuation rule, and needs its own decision.

**First administrator.** A browser opened with an explicit `#key=` link in OIDC mode shows a
recovery dialog with two actions: **Link an administrator sign-in** and **Create a local recovery
identity** (today's bootstrap). The first starts `intent: "link-administrator"` authenticated by
the owner key, which is sent only as the bearer of that start request, exactly as bootstrap sends
it today (`packages/web/src/api.ts:47-64`). The callback, bound to the same browser's transaction,
refuses an already-bound subject, creates a new human principal admitted with the template
`{ caps: ["*"] }` and records `external_identity_linked { byOwnerKey: true }` and
`principal_admitted`. Proof is possession of the owner key plus authentication at the issuer in one
transaction. No other intent creates an administrator outside a root door. The owner principal
itself is never bound, so the undeniable, unpausable break-glass identity stays a secret rather
than an IdP account.

**Unknown subjects.** A valid sign-in whose subject has no binding, or whose bound principal has no
admission, mints nothing: no principal, no credential, no API or socket access. The callback upserts
one `access_requests` row keyed by `(issuer, subject)` with the profile display claims, the
validated `returnTo` the person was trying to open, first and last attempt times and a counter. The
table holds at most 200 pending rows; at the cap new subjects see that requests are full and no row
is evicted. Pending rows expire after 30 days. The callback renders the **signed-in but not
admitted** page: the display name and issuer host, "an administrator must admit this account", a
note that forwarding the link does not grant access, and a provider sign-out link so another
account can be used.

**Approval** (`core.access.admit`, root, traced) names a request or principal, a template, an
optional display name and `acknowledgedAnyHumanGrants`: the exact ids of the current `any-human`
allow rows.
When admission would materialize a new human principal and that set differs from the current rows,
the door refuses `any_human_audience_changed` and returns the current set, so onboarding never
widens an `any-human` grant silently. The listing door returns pending requests, bindings,
admissions and the current `any-human` rows together.

**Deep links, forwarding, expiry and revocation.** An ordinary URL is a locator, never authority.
Following it signs in and returns to it; an unadmitted account gets the page above, and an admitted
account without the resource's `containers:read` gets an in-app refusal naming the signed-in
identity and the resource with a sign-out action, never an empty workspace. Forwarding a link lets
the recipient file a request and nothing more. There are no invitation secrets in the recommended
form (decision D3). Requests expire; admission is withdrawn by `removeAdmission`, pause or grant
revocation, which bite live through the existing epoch and socket fences.

**Anonymous and bearer-link access.** There is none today: every door refuses an unauthenticated
caller ([SELF-HOST](../SELF-HOST.md#security-posture)) and the only URL carrier is `#key=`. OIDC
adds none. Decision D2 records whether non-root holders of `tokens:mint` may still create new
unbound human principals in OIDC mode.

## Sessions, renewal, logout and deprovisioning

Each successful sign-in mints one ordinary human credential through `persistToken` with the
existing 14-day interactive lifetime (`auth.ts:254`) and one `oidc_sessions` row
`{ tokenId, externalIdentityId, providerSessionId?, refreshToken, revalidatedAt,
lastRevalidationFailureAt? }`. Two browsers for one subject share a principal and hold distinct,
separately listed and revocable credentials.

**Storage.** The browser keeps only the Manifold bearer, in the same per-instance `localStorage`
register every browser credential uses; the API stays bearer-only, so the portable lens and the
cross-origin API policy (`http.ts:327-340`) are unchanged. A cookie session was rejected: it would
add ambient authority and CSRF to every door, break the lens, and contradict ADR 0027's
no-ambient-cookie rule. The refresh token stays server-side in SQLite. It is usable only with the
client secret, which lives in the environment and not in the database or its replica
([RFC 6749 §6](https://www.rfc-editor.org/rfc/rfc6749.html#section-6),
[RFC 9700 §2.2.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.2.2)). Numbered-preview
seeding already empties every table outside its projection
([CONTRACTS](../CONTRACTS.md#production-identity-handoff-to-disposable-previews-adr-0027)); any
other path that copies a production database into a less-trusted process must exclude
`oidc_sessions` the same way (V17). Envelope encryption was rejected: its key would be one more
provider-held secret, or, on a hub whose data directory is ephemeral (ADR 0022), a regenerated
key would sign everyone out on each deploy, while adding little beyond the client-secret binding.

**Revalidation (recommended D1-B).** Every 15 minutes the server refreshes each live OIDC session,
at most four concurrently with a 10-second timeout each, stores a rotated refresh token, and checks
that a returned ID token has the bound `iss` and `sub`; the library does not compare them on refresh.
Outcome classes:

| Token-endpoint outcome                                                                                                                                                                 | Manifold action                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success                                                                                                                                                                                | Record `revalidatedAt`.                                                                                                                                                          |
| OAuth `invalid_grant` (user disabled, IdP session ended or expired, refresh token revoked) or a changed `iss`/`sub`                                                                    | Revoke exactly that credential and its token-owned rows; sockets close `4403 revoked`; record `oidc_session_ended { reason }`. Re-enabling the user at the IdP does not resurrect it. |
| Timeout, network failure, `5xx`, `invalid_client`, unknown signing key or another non-definitive error                                                                                | Keep the session, record a rate-limited `oidc_revalidation_failed`, surface provider health to administrators.                                                                     |
| No successful revalidation for 24 hours                                                                                                                                                | Revoke as above with reason `provider_unreachable`.                                                                                                                                |

`invalid_client` is classified as configuration, not deprovisioning, so a mistaken or rotated
client secret cannot sign everyone out. Revalidation keeps the IdP's idle timer alive; the IdP's
maximum session lifetime still ends the Manifold session at the next pass.

**Logout.**

- **Sign out of this browser** calls `POST /auth/oidc/logout` with the bearer. The server revokes
  exactly that credential and session row, then returns an RP-initiated logout URL
  ([OpenID RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html#RPLogout))
  with `client_id` and the registered post-logout URI. The browser follows it, ending that browser's
  IdP session; the provider may show a confirmation because no ID token is stored for
  `id_token_hint`. `/auth/oidc/signed-out` never starts a new sign-in by itself. Without an
  `end_session_endpoint`, sign-out is local and the page says the IdP session may remain.
- **Sign out everywhere** (`{ everywhere: true }`) revokes every OIDC credential of the presenting
  principal. It does not touch Agents' own credentials, Runs, machines, native services or
  terminal-lifecycle identities; the principal's other credentials, such as pre-OIDC device tokens
  or self-minted automation credentials, stay listed for explicit withdrawal.
- **Administrator, one device:** `core.access.revoke` gains an optional credential id; the server
  still selects eligibility, so one browser can be withdrawn without the others.
- **Administrator, all devices:** existing `revoke`, `pause` and the new `removeAdmission`.

**Deprovisioning bound (honest maximum lag)** under D1-B:

| Event                                                                 | Effect on Manifold                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IdP user disabled, IdP session ended (logout, admin sign-out, expiry) | That subject's credentials revoked at the next pass: **at most 15 minutes plus one pass** while the IdP answers; at most **24 hours plus one pass** while it does not.                                                       |
| Manifold `pause`, `revoke`, `removeAdmission`, unlink                 | Immediate at the next authorization check; sockets fenced.                                                                                                                                                                |
| Preview credentials already minted from that identity                  | Unchanged by ADR 0028: valid until their own 14-day expiry or revocation on the preview; a new or renewed preview admission is refused at once because production no longer issues assertions for a revoked credential.     |
| Agents authorized by a revoked browser credential                      | Effective authority empties at once (`auth.ts:1240-1254`); the sponsor re-authorizes from a live credential with `updateAgent` (`auth.ts:2687-2698`). The sign-out confirmation names the affected Agents.                    |
| Processes already running in that human's terminals                    | Unaffected: terminal-lifecycle identities are independent (`auth.ts:3888-3937`). Stopping them is an explicit `core.terminals` kill. Pause does not stop work (ADR 0046).                                                    |
| Machine enrollment and native service credentials                      | Unaffected.                                                                                                                                                                                                                |

Under D1-A the first row becomes "no effect until the 14-day credential expires". Manifold never
claims that IdP logout ends a Manifold credential unless D1-B or D1-C is the ratified answer.

**Provider outage.** Sign-in renders `provider_unavailable` with a retry and a pointer to recovery.
Existing sessions continue within the outage bound. The owner key still opens the recovery dialog.
Nothing degrades to root, to anonymous access or to a stored owner key.

## Coverage matrix

| Credential path                                                  | Design                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human browser and reconnect                                      | OIDC admission as above; reconnect presents the stored bearer on the session handshake (`session-ws.ts:582-609`); `revoked`/`expired` returns the gate to sign-in with the current location as `returnTo`.                                                                                                              |
| HTTP, WebSocket and plugin actions                               | Unchanged: one bearer, one `AuthContext`, the same evaluator, `AUTH_REFUSALS`, epoch invalidation and socket fences. Plugins see a principal, never an issuer, subject or IdP token.                                                                                                                                    |
| Human-operated CLI and SDK                                       | A signed-in human with `tokens:mint` mints a scoped, expiring credential for themselves through the existing automation panel (`packages/plugins/access/src/shell-automation.tsx:149-160`); no owner key. Device authorization ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html#section-1)) is not built until a human-login CLI consumer exists. |
| Agents, Runs and action runners                                  | Unchanged ADR 0039/0042 lineage: sponsor-bound standing grants, exact policy acknowledgement, renewal through the runner, revocation by Run subtree. No borrowed human IdP token; an IdP access or ID token presented as a bearer is `unauthorized`.                                                                     |
| Machines, terminal-lifecycle and native services                 | Unchanged internal lifecycles; no redirect, re-enrollment or revocation as a side effect of human sign-in or sign-out.                                                                                                                                                                                                   |
| Cross-instance shares                                            | Unchanged [#412](https://github.com/atyrode/manifold/issues/412) contract: the host approves each `(guest origin, guest-local principal id)` and remote subset. The guest's OIDC is invisible to the host; no IdP credential crosses; a shared issuer between instances is not federation.                                  |
| Production, integrated and numbered previews                     | Production may be an OIDC relying party and the preview identity authority at once. Previews are never OIDC relying parties, have no redirect URI registered at the IdP, and keep the ADR 0027 exact-audience, nonce-bound, single-use handoff and ADR 0028 lifetime. No additional preview consent prompt.                |
| Offline, no-OIDC and recovery                                    | Unchanged: no configuration means today's owner-key bootstrap and tokens; an explicit `#key=` link remains the break-glass route in OIDC mode.                                                                                                                                                                          |
| Foreign lens (`?instance=`)                                      | Not supported in the first delivery: the callback can deliver a credential only to the instance's own origin. The lens offers a link to sign in on that instance's origin; cross-origin delivery would need its own audience-bound design.                                                                                |

Accepting an external JWT as a Manifold bearer, or federating workload identity, is not part of
this design and would need its own decision.

## Library verdict

**Use `openid-client` 6.8.8, exactly pinned**, with its lockfile-pinned dependencies `oauth4webapi`
3.8.8 and `jose` 6.2.12. Observed from the npm registry on 2026-10-03: all three are MIT, published
2026-09-05 with registry attestations, and have no further runtime dependencies; a clean disposable
install resolved exactly these three packages. The
[README](https://github.com/panva/openid-client/blob/v6.x/README.md) lists Bun among supported
runtimes and states OpenID Foundation certification of the Basic, FAPI 1.0 and FAPI 2.0 relying
party profiles; the [v6.x package](https://github.com/panva/openid-client/blob/v6.x/package.json)
runs a `tap:bun` suite. It provides discovery with issuer validation, the code grant with PKCE,
state, nonce and RFC 9207 checks, refresh, RP-initiated logout URLs, HTTPS-only defaults and
timeouts; all but the HTTPS-only default, which the loopback probe disabled, were exercised under
Bun 1.4.2 below. Security issues follow its published
[security policy](https://github.com/panva/openid-client/security/policy). The pin lands only in the
implementing slice, under [Dependency decisions](../CONTRACTS.md#dependency-decisions).

Rejected:

- **Hand-written OAuth with `jose` alone.** Reimplements discovery validation, PKCE, state, the
  RFC 9207 check and token error handling: the custom protocol code #324 rules out.
- **`oauth4webapi` alone.** Same author and validation core with no dependency, but every step
  (`validateAuthResponse`, token request, response processing, signature checks) becomes Manifold
  glue. `jose` costs about 210 KB unpacked and no further dependencies; less glue is the safer trade.
- **Provider-specific OAuth helpers** such as [Arctic](https://arcticjs.dev/guides/oauth2), whose
  documented OIDC helper decodes the ID-token payload, leaving issuer, audience, nonce, algorithm
  and signature validation to Manifold, and which is organized per provider.
- **Full authentication frameworks** with their own user, account and session tables: a second
  identity and authority system beside the A5 waterfall.
- **An OIDC-terminating proxy as the feature.** It authenticates the edge but cannot distinguish
  humans inside Manifold (ADR 0019 §5); it remains a documented deployment mode.

## Ownership, plane and foundation law

- `packages/server/src/oidc.ts` (new): configuration, discovery cache, transaction store,
  start/callback/logout routes' protocol work, ID-token checks and the revalidation loop. It joins
  the existing `identity-caps` pillar in the same commit as its code. **Bootstrap:** sign-in runs
  before any principal or plugin host exists, like preview admission. **Neutrality:** it names
  issuers, subjects, principals and credentials, never a plugin, workspace noun or provider.
  **Arbitration:** it is the sole boundary deciding whether an external authentication becomes a
  local credential. Routes are wired in `http.ts` (`assembly-engine`); principal, token and grant
  mutations stay in `AuthService`.
- Persistence (`external_identities`, `principal_admissions`, `access_requests`, `oidc_sessions`)
  is a schema migration in the existing persistence pillar, with no automatic bindings or
  admissions.
- Admission is Action-plane state: it depends on root authority the subject lacks. `core.access`
  owns `listAdmissions`, `admit`, `removeAdmission`, `denyAccessRequest` and `unlinkIdentity`,
  root-only and traced, plus the optional credential id on `revoke`. No new plugin seat, capability
  or floor door.
- The callback and revalidation are identity-boundary acts without an actor at a door. They write
  journal events (`external_identity_signed_in`, `external_identity_linked`, `access_requested`,
  `oidc_session_ended`, `oidc_revalidation_failed`), matching `owner_authenticated` and
  `preview_identity_accepted`, and never trace rows.
- The web gate stays in `identity.tsx`/`identity-storage.ts`; Access UI lives in the access plugin.
- New lexicon rows for **external identity**, **admission** and **access request** land with the
  code that introduces them.

## Relation to ADR 0019 and the living spec

ADR 0019 stays accepted; records are immutable. This proposal keeps §1 (owner key forever; offline
localhost floor; agents never route through a human login), §2 (finite credentials), §3 (inventory
and withdrawal) and §4 (bootstrap audit). It refines §6: #324 selects OIDC as the preferred
configured human sign-in now, rather than waiting for its revisit trigger, the relying party sits
in front of _principal creation_ and never the root bootstrap door, and this record supplies the
dependency verdict §6 deferred. Until the decisions below are ratified, CONTRACTS records OIDC as
proposed and unimplemented; ratification and the implementing slices edit
[CONTRACTS §Identity](../CONTRACTS.md#identity-tokens-capabilities), the HTTP API and runtime tables,
`REGISTRY.md` and `docs/SELF-HOST.md` with the code.

## Decisions for operator ratification

### D1 — How long a Manifold browser session survives IdP withdrawal

**Question:** After OIDC sign-in, should the Manifold credential be bound to the IdP session?

- **A — Independent.** Today's 14-day credential; IdP disable or logout has no effect; withdrawal is
  Manifold-only. Lag up to 14 days. No refresh token stored.
- **B — IdP-bound revalidation.** Server-held refresh token checked every 15 minutes; a definitive
  refusal revokes the exact credential and fences its sockets. Lag at most 15 minutes plus one pass,
  or 24 hours plus one pass during an IdP outage. The provider's session maximum (14 days in the
  recipe) governs re-sign-in. **Recommended.**
- **C — B plus Back-Channel Logout.** Adds a logout-token receiver
  ([OpenID Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html#LogoutToken))
  for near-immediate IdP logout propagation. More code and an inbound endpoint; disable still relies
  on revalidation unless separately proved.
- **D — Short credential renewed by browser redirect.** No server-held refresh token; lag equals the
  short lifetime, but sockets are fenced and the page re-redirects at every renewal, the experience
  ADR 0028 removed.

### D2 — Unbound human credentials in OIDC mode

**Question:** With OIDC configured, may non-root holders of `tokens:mint` keep creating new human
principals through `core.access.mint` (`auth.ts:2146`)?

- **A — Root only.** Non-root `mint`/`mintV2` with an inline new `principal` refuses
  `human_admission_required`; minting for an existing principal, including oneself, is unchanged;
  root may still create an explicitly labeled local principal. **Recommended:** an unbound human is
  otherwise a way around admission.
- **B — Unchanged.** Any `tokens:mint` holder may create unbound humans, shown as local credentials.
- **C — Per-instance opt-in.** A, unless the operator sets an explicit setting restoring B.

### D3 — How an invitee reaches admission

**Question:** Besides request-then-approve, should Manifold issue invitation links?

- **A — Request and approve only.** No invitation secret exists; the deep link is the invitation and
  approval names the exact subject. Forwarding yields only a request. Two steps for a new
  collaborator. **Recommended** for the first delivery.
- **B — Plus single-use pre-approved invitation links.** A root-created secret link, expiring after
  72 hours, binds to whoever redeems it first while signed in; the redemption is shown and
  revocable. One step, with a forwarding window until redemption.
- **C — B with a required verified email.** Redemption also requires `email_verified` and an email
  equal to the invitation's. Reduces forwarding, but depends on the issuer's email and linking
  policy; the binding is still `(iss, sub)`.

## Keycloak reference integration

Keycloak is external, operator-run and never bundled (ADR 0019 rejects bundling). Manifold sees one
realm as one issuer, `https://<keycloak-host>/realms/<realm>`. Steps, with
[Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html) anchors:

1. **Realm.** A dedicated realm such as `manifold`; never the `master` realm. The observed
   [session defaults](https://www.keycloak.org/docs/latest/server_admin/index.html#_timeouts) are
   SSO Session Idle 30 minutes and SSO Session Max 10 hours, which under D1-B means daily sign-in.
   For today's 14-day experience set SSO Session Max to 14 days and keep SSO Session Idle above the
   15-minute revalidation interval (the default qualifies). Leave Revoke Refresh Token off (the
   realm default) unless you accept that a crash between rotation and persistence signs a browser
   out. Keep self-registration off for a closed instance.
2. **Client** ([creating an OIDC client](https://www.keycloak.org/docs/latest/server_admin/index.html#proc-creating-oidc-client_server_administration_guide)):
   client id `manifold`; Client authentication on (confidential); Standard flow only, with Implicit,
   Direct access grants, Service accounts and Device grant off; Valid redirect URIs exactly
   `https://<manifold-host>/auth/oidc/callback`; Valid post logout redirect URIs exactly
   `https://<manifold-host>/auth/oidc/signed-out`; Web origins empty; no wildcards. Advanced:
   PKCE method `S256` ([PKCE setting](https://www.keycloak.org/docs/latest/server_admin/index.html#_proof-key-for-code-exchange)).
   Front-channel and back-channel logout off unless D1-C is chosen. Optionally enforce HTTPS,
   no-wildcard redirect URIs and PKCE with
   [client policies](https://www.keycloak.org/docs/latest/server_admin/index.html#securing-client-uris).
3. **Scopes and claims.** Default client scopes `profile` (display claims); `email` optional for the
   approver's display; remove `offline_access` from the client's optional scopes. Manifold needs only
   `sub`. After brokering, Keycloak issues its own tokens for the realm user
   ([broker overview](https://www.keycloak.org/docs/latest/server_admin/index.html#_identity_broker_overview));
   the probe observed a 36-character `sub`. Identities linked to one realm user therefore reach
   Manifold as that user's one `sub` (inferred from the broker model, not exercised).
4. **Secret delivery and rotation.** Copy the client secret into `MANIFOLD_OIDC_CLIENT_SECRET` in
   the hub's environment only. To rotate without downtime use a
   [client secret rotation policy](https://www.keycloak.org/docs/latest/server_admin/index.html#rules-for-client-secret-rotation),
   which keeps the previous secret valid for its rotated-secret expiry: regenerate, update the
   environment, restart the hub within that window. Without the policy, regeneration invalidates the
   old secret immediately; sign-in and revalidation fail as `invalid_client` until the hub restarts,
   and sessions are not revoked for it.
5. **Signing keys.** RS256 is the realm default. Rotate by adding the new key passive, waiting at
   least five minutes, then making it active
   ([rotating keys](https://www.keycloak.org/docs/latest/server_admin/index.html#rotating-keys)).
6. **Public origin, proxy and TLS.** Run production mode with an explicit `--hostname`, which
   Keycloak documents as preventing tokens from a fraudulent issuer
   ([hostname guide](https://www.keycloak.org/server/hostname)); never `--hostname-strict=false`
   with untrusted forwarded headers. Behind a proxy set `--proxy-headers` to match it and expose
   `/realms/` and `/resources/`, keeping `/admin/` and `/realms/master/` internal
   ([reverse proxy guide](https://www.keycloak.org/server/reverseproxy)). Manifold's own proxy
   follows [Already running a reverse proxy](../SELF-HOST.md#already-running-a-reverse-proxy-on-this-box)
   with an explicit HTTPS `MANIFOLD_PUBLIC_URL`. Do not serve Keycloak and Manifold under one
   parent-domain cookie scheme; Manifold uses no parent-domain cookies.
7. **Admission and recovery.** Configure Manifold, open the owner `#key=` link once and use **Link
   an administrator sign-in**. Later people sign in, appear as access requests and are admitted.
   If Keycloak is down or misconfigured, the owner link's **Create a local recovery identity**
   remains; lost Keycloak admin access is recovered with Keycloak's own bootstrap-admin procedure,
   not through Manifold.
8. **Brokered social login.** Add Google or GitHub as
   [identity providers](https://www.keycloak.org/docs/latest/server_admin/index.html#social-identity-providers)
   in the realm; register the Redirect URI Keycloak displays for that provider at
   [Google](https://www.keycloak.org/docs/latest/server_admin/index.html#_google) or
   [GitHub](https://www.keycloak.org/docs/latest/server_admin/index.html#_github). Keep the default
   [first broker login flow](https://www.keycloak.org/docs/latest/server_admin/index.html#_identity_broker_first_login),
   which confirms a link to an existing account by email verification or re-authentication. Do not
   use automatic linking: Keycloak itself calls it dangerous where users can register arbitrary
   usernames or emails. Enable Trust Email only for an upstream that verifies email. Use the
   "detect existing broker user" flow to let only pre-created realm users sign in. Manifold needs no
   code per social provider: it only ever sees the realm issuer and the realm `sub`.

## Clever Cloud recipe and boundaries

The operator's hub is already hosted on Clever Cloud (ADR 0022); Keycloak would be a separate
add-on and is not part of a Manifold deployment. Per
[Clever Cloud's Keycloak documentation](https://www.clever.cloud/developers/doc/deploy/services/keycloak/),
creating it provisions a Java application with Keycloak, a PostgreSQL database and an FS Bucket for
themes, plugins and import/export; the default sizing is an S Java instance, an XXS PostgreSQL plan
and under 100 MB of bucket, and Secured Multi Instances bills a second Java instance. **Creating it
is spend and requires explicit operator authority**; nothing here provisions it.

1. Create the add-on in the console or with `clever addon create keycloak <name> --org <org>`,
   optionally `--option access-domain=auth.<domain>` with a CNAME to the zone's
   `domain.<zone>.clever-cloud.com.` record. Change the temporary admin password at first login.
2. Declare the realm through `CC_KEYCLOAK_REALMS=manifold` on the add-on's Java application and
   restart, the provider's recommended route. Nothing in the documented creation workflow creates
   the Manifold client, its redirect URIs, any social application or any user: do steps 2-8 above.
   Since add-on release 26.2, `admin-cli` is disabled; leave it so unless provisioning by API is
   authorized.
3. Set `CC_KEYCLOAK_HOSTNAME` for a custom domain; optionally move the admin console to
   `CC_KEYCLOAK_HOSTNAME_ADMIN` and restrict admin endpoints with `CC_KEYCLOAK_ADMIN_IPS_<REALM>`
   (add-on 26.6 or later).
4. Set `MANIFOLD_OIDC_ISSUER=https://auth.<domain>/realms/manifold`, `MANIFOLD_OIDC_CLIENT_ID` and
   `MANIFOLD_OIDC_CLIENT_SECRET` on the Manifold hub's environment through the existing provider-side
   configuration route, never in the tree (S17 keeps provider names out of shipped files).
5. Full realm exports (`CC_KEYCLOAK_EXPORT_REALMS`) include client secrets and password hashes and
   land in the FS Bucket: treat the bucket as secret material.
6. Version changes use the dashboard, Clever Tools or `CC_KEYCLOAK_VERSION`; rehearse them on a
   disposable add-on first.

Unexercised in this milestone: the add-on's actual resources, defaults, hostnames, IP filters,
exports, availability and pricing; any Google or GitHub application; TLS on a real hostname; and
every Manifold behavior, which does not exist yet.

## Generic provider compatibility

Any OpenID Provider works if it publishes Discovery with an exact `https` issuer; supports the code
grant with PKCE `S256`; authenticates a confidential client with `client_secret_basic` or
`client_secret_post`; signs ID tokens with the pinned asymmetric algorithm; never reassigns `sub`;
and, for D1-B, issues a refresh token to the code grant that ends with the user's provider session
without `offline_access`. An `end_session_endpoint` and the RFC 9207 `iss` parameter are recommended
and used when present. Only local Keycloak 26.7.2 was exercised; no other provider, hosted
Keycloak or browser combination is claimed.

## Evidence observed in this milestone

All runs were disposable and on loopback. Nothing here is Manifold integration, hosted Keycloak,
social login or deployed evidence.

- **Source inspection** at `c905264c` of the seams in the first table.
- **Library and provider probe.** `quay.io/keycloak/keycloak:26.7.2` in `start-dev` on
  `127.0.0.1` over HTTP; a throwaway realm, confidential client (redirect and post-logout URIs exact,
  PKCE `S256` required) and two fixture users with identical names; `openid-client` 6.8.8 under Bun
  1.4.2 with `allowInsecureRequests` (loopback only) and `enableNonRepudiationChecks`, RS256 pinned.
  Observed:
  - discovery: issuer matched exactly; `S256` advertised; `authorization_response_iss_parameter_supported: true`;
    `end_session_endpoint`, `jwks_uri` on the issuer origin; back-channel logout advertised;
  - callback parameters `code`, `state`, `iss`, `session_state`; ID token RS256 with `aud` and `azp`
    equal to the client id, a `sid`, the matched nonce and a refresh token;
  - code replay → `invalid_grant` "Code not valid"; wrong PKCE verifier → `invalid_grant` "PKCE
    verification failed"; state mismatch and forged `iss` parameter → `OAUTH_INVALID_RESPONSE` before
    redemption; nonce mismatch → `OAUTH_JWT_CLAIM_COMPARISON_FAILED`; PKCE omitted → provider
    `invalid_request`; redirect URI with extra query, extra path or another origin → HTTP 400 with no
    redirect; unregistered post-logout URI → HTTP 400; ES256 pinned against RS256 tokens → rejected;
  - two cookie jars for one user → same `sub`, different `sid`; two users with identical names →
    different `sub`;
  - refresh succeeded and returned a new refresh token and an ID token with the same `sub`; after
    disabling the user, refresh → `invalid_grant` "User disabled" and a new login failed; after
    re-enabling, the **old refresh token worked again**, so Manifold must revoke on the first
    definitive refusal rather than pause; after admin sign-out or RP-initiated logout with
    `id_token_hint`, refresh → `invalid_grant` "Session not active", and RP-initiated logout
    redirected only to the registered URI. The `client_id`-only logout this design proposes, with
    its possible confirmation page, was not exercised;
  - a new active RS256 key with higher priority made an exchange 0 seconds after the JWKS cache
    fill fail with `OAUTH_KEY_SELECTION_FAILED`; a login 61 seconds after the fill succeeded with
    the new `kid`; a passive key was published in the realm JWKS;
  - refresh during a paused provider → `OAUTH_TIMEOUT` after the 5-second probe timeout, a
    non-definitive outcome;
  - realm defaults: SSO Session Idle 1,800 s, SSO Session Max 36,000 s, access token 300 s,
    authorization code 60 s, Revoke Refresh Token off, RS256.
  - Cleanup: the container (unique name and label) was removed; no container or dangling volume
    with the label remained; the probe directory was deleted. The Keycloak image was already
    present locally and was left in place.

## Threats and controls

| Threat                                                    | Control                                                                                                         | Verification |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| First public login becomes administrator                  | Admission is root-only; the first administrator needs the owner key in the same transaction                     | V4, V14      |
| Login silently widens `any-human` grants                  | No principal before admission; `admit` requires the exact current `any-human` set                               | V4           |
| Account merge by email or name                            | Lookup only by `(iss, sub)`; every link ends in a root admission decision                                       | V3, V15      |
| Stolen bearer turned into a durable sign-in               | Self-link creates a binding only; a root actor must still admit                                                 | V15          |
| Login CSRF or callback injection                          | `__Host-` transaction cookie, single-use transaction, exact state, nonce and PKCE                                | V8           |
| Authorization code theft or replay                        | Exact redirect URI, PKCE `S256`, provider single use, `no-referrer`, history replacement                        | V8           |
| IdP mix-up or attacker-selected endpoints                 | One configured issuer, exact discovery issuer, RFC 9207 check, no request-selected endpoints                    | V8           |
| Forged or wrong-audience ID token                         | Signature on, pinned asymmetric algorithm, exact `iss`, `aud`, `azp`                                            | V8, V9       |
| Open redirect through `returnTo`                          | Relative-path allowlist                                                                                         | V8           |
| IdP token used as a Manifold bearer                       | Bearer lookup is hash-only; IdP tokens never leave the server                                                   | V16          |
| Client secret or refresh token reaches a preview          | OIDC and identity-authority configuration are mutually exclusive; preview seeding empties the tables          | V17          |
| Deprovisioned user keeps access                           | D1 revalidation, `removeAdmission`, pause, per-credential revoke                                                | V10, V11     |
| IdP outage becomes privilege                              | No fallback; owner key only by explicit link                                                                    | V12, V13     |
| Secrets or personal data in logs, traces or events        | Closed refusal vocabulary, id-only events, no `cause` logging                                                   | V19          |

## Implementation slices and dependencies

Each slice is separately claimable after ratification and before its own triage; none is authorized
by this record.

| #   | Slice                                                                                                                                                                                                                                                                                                                      | Depends on        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| S0  | Ratify D1-D3 and this record; edit the CONTRACTS identity text and REGISTRY plan to the ratified answers.                                                                                                                                                                                                                 | —                 |
| S1  | Protocol schemas (identity configuration, admission doors, revoke credential id) and the persistence migration with store accessors; registry rows; preview projection test.                                                                                                                                             | S0                |
| S2  | `oidc.ts`: configuration and fail-closed validation, discovery cache, transaction store, start/callback routes, ID-token checks, resolution, credential and session minting, callback document, events; exact `openid-client` pin.                                                                                       | S1                |
| S3  | `core.access` admission doors, `any-human` acknowledgement, D2 rule, owner-key administrator link, self-link.                                                                                                                                                                                                               | S1; S2 end to end |
| S4  | Logout routes, RP-initiated logout, sign-out everywhere, per-credential revoke, D1 revalidation loop and outcome classes.                                                                                                                                                                                                  | S2                |
| S5  | Web: sign-in gate, deep-link `returnTo`, recovery dialog, not-admitted and resource-refusal views, sign-out controls, Access UI for requests, bindings and admissions. Real-browser screenshots inspected.                                                                                                                 | S2-S4             |
| S6  | CONTRACTS, HTTP and runtime tables, SELF-HOST setup with the Keycloak and Clever Cloud recipes, change fragment.                                                                                                                                                                                                           | S2-S5             |
| S7  | Disposable verification harness (V1-V20) and its CI selection.                                                                                                                                                                                                                                                             | S2-S5             |

Already delivered and only regression-checked: #412 host-approved recipients (closed 2026-10-01).
Preserved, not closed by this work: #468 preview recovery and its separately owned deployed-origin
receipt. Independent: the in-flight capability migration touching `auth.ts` is a merge-order
concern for S2-S4, not a design dependency. Any delegated admission depends on ADR 0011 §8's
deny-attenuation decision.

## Verification plan

**Disposable and local (S7).** Fixture: a pinned Keycloak container on loopback with an imported
test realm, a throwaway Manifold data directory and Playwright Chromium. Before relying on it,
prove that Chromium accepts the `__Host-` cookie on `http://localhost`; otherwise the fixture uses
local TLS. Deterministic `RuntimeDeps` clocks cover the 15-minute and 24-hour bounds, and one
real-time run measures the 15-minute bound.

| Id  | Proves                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | A fresh browser follows a deep link, signs in and reaches exactly that resource; screenshots of each transition inspected.                                                  |
| V2  | Two browsers, one subject: one principal, two credentials; revoking one leaves the other.                                                                                     |
| V3  | Two subjects with identical names and emails remain two principals.                                                                                                          |
| V4  | An unadmitted account gets no credential and no API or socket access; a request appears; a stale `any-human` acknowledgement is refused; the first login is not an administrator. |
| V5  | A collaborator admitted to one container cannot read other containers, spawn or control a terminal beyond its template, or call root doors, over HTTP and sockets.        |
| V6  | Grant and grant revocation, template narrowing and `removeAdmission` bite live over HTTP and sockets.                                                                        |
| V7  | A forwarded link yields only a request for the second account.                                                                                                              |
| V8  | Cancellation, provider error, state, nonce, PKCE and `iss` mismatch, code replay, wrong audience (second client), redirect variants, `returnTo` attacks, missing or foreign transaction cookie and a tossed `Domain` cookie all refuse with no credential. |
| V9  | Passive-first key rotation succeeds; immediate rotation fails once within the 60-second window and then succeeds; wrong algorithm refused.                                 |
| V10 | Disable, admin sign-out and session expiry at the IdP revoke the Manifold credential within the bound; re-enabling does not resurrect it.                                  |
| V11 | Sign out of this browser and everywhere revoke the right credentials and end the IdP session; Agents, Runs, machines and services untouched; affected Agents named.           |
| V12 | IdP outage: sessions continue, sign-in shows `provider_unavailable`, revocation after 24 hours, nothing falls back.                                                         |
| V13 | Owner-key recovery with the IdP down; no-OIDC offline startup unchanged.                                                                                                    |
| V14 | Owner-key administrator link; a second link of the same subject refused; link without the owner key refused.                                                                  |
| V15 | Self-link preserves principal id, grants, layout and trace attribution and signs in only after a root `admit`; owner, scoped, remote and already-bound cases refused.          |
| V16 | Machine, Agent, Run, runner, native-service and terminal-lifecycle credentials keep their lifecycles; IdP tokens presented as bearers are `unauthorized`.                  |
| V17 | Production-to-preview handoff from an OIDC identity unchanged, including #468's revoked/expired readmission without owner-key fallback; OIDC plus identity authority refuses to start; no client secret or IdP token in preview environment, bundle or database. |
| V18 | Two disposable instances: an OIDC host shares with a guest under #412 approval; no IdP credential crosses; origins are instance origins.                                     |
| V19 | Logs, events and traces contain no code, token, refresh token, subject string or claim set.                                                                                  |
| V20 | A signed-in human mints a scoped CLI credential; D2's answer holds for non-root new-human mints.                                                                             |
| V21 | A second disposable realm brokered as an upstream OIDC provider reaches Manifold as the brokering realm's `sub`, with no provider-specific Manifold code.                      |

**Separately authorized, not part of S7.** Hosted Keycloak on Clever Cloud (spend); real Google and
GitHub OAuth applications (provider accounts); Manifold on its real public origin with real TLS;
real-browser production and preview journeys. Each needs its own authorization and reports the
exact provider, browser and build exercised. Source, release, deployment and runtime evidence are
recorded separately, and a disposable fixture result is never reported as Keycloak hosting,
social-login or deployed proof.

## Non-goals

First-party passwords or passkeys; a bundled IdP; SAML; SCIM provisioning; IdP group or role claims
deciding Manifold authority; accepting external JWTs as bearers; workload identity federation;
cross-instance identity federation through a shared IdP; foreign-lens sign-in; delegated admission;
extra preview consent; and any change to owner-key semantics.
