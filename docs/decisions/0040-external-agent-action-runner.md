# External agents use one SDK transport and a process-owned bounded action runner

Date: 2026-09-13
Status: accepted
Ratified: operator selection “Broader delegation now” for #553 on 2026-09-13; consumes #559/#558 as merged in #560.

Superseded in part (2026-09-14) by [ADR 0042: durable Agents](0042-durable-agents.md):
model-authored `start` and a general sponsor credential are replaced by launcher-only
Agent/run environment binding. The bounded action transport, exact explicit policy
acknowledgement, redacted output and finally-owned teardown remain in force. Harness activity
uses a separate inherited bounded pipe or the trusted SDK method, not a model frame.

## Context

The action plane was typed and discoverable, but an external agent's immediately available
interface was often an authenticated browser. That made administrative DOM automation easier
than truthful run admission, exact policy delivery and accountable teardown. A CLI with its own
HTTP implementation would merely add a competing convention beside `SessionClient.action` and
plugin-kit dispatch.

The normative contract is [External action runner](../CONTRACTS.md#external-action-runner).
The point-of-use instructions are in root `AGENTS.md` and `packages/sdk/README.md`.

## Decision

Extract authenticated protocol discovery and HTTP action invocation into `@manifold/sdk`.
Sessions, plugin-kit and a real executable JSONL runner all consume it. `POST /api/actions/:name`
remains the sole semantic boundary. The existing durable numeric trace id is returned in
`x-manifold-trace-id`, including known-door refusals and broken handlers; the strict action body
and ordinary UI callers do not change. Unknown names and pre-dispatch failures get no invented id.
The optional bounded justification header uses this same transport; #557 owns its declaration,
validation, persistence and inspection rather than the runner inventing a second audit record.
The header uses an explicit reversible ASCII codec (`v1.` plus `encodeURIComponent`), avoiding
HTTP's Latin-1/control-character restrictions without changing Unicode claim semantics.
Malformed encodings fail closed before dispatch instead of becoming missing justification.

The trusted launcher supplies one authorized sponsor credential through the process environment.
The runner withdraws that entry before reading untrusted frames, creates an accountable root run,
retains root/child/replacement bearers privately, and delivers live schemas plus exact server policy.
Acknowledgement is explicit and exact. Child creation, renewal, policy refresh/re-ack and finish use
#560's published lifecycle doors. Ordinary invocation cannot substitute for those lifecycle frames.
The runner's owned root need not be the server chain's root: an accountable-agent launcher
remains its direct sponsor, so renewal and teardown select the retained credential by owned-root
identity. Shared transport limits remain opt-in, preserving long-running UI/service calls;
only the runner imposes its mandatory bounds (plugin-kit retains its existing timeout).
No browser fallback, new enrollment route, authentication inference, alternate authority evaluator
or preview-human impersonation is introduced.

Stdout is a bounded mechanical projection: door, caller-declared target, run id, outcome/refusal
rule, trace id and narrowly typed lifecycle facts. Arbitrary result bodies and refusal messages
are excluded because they can contain credentials, arguments or terminal/native output. Policy
bytes are an intentional exception: exact trusted policy must be delivered, never silently
redacted. A challenge containing a held credential fails closed. Digests here identify public
policy bytes, not credentials. SDK consumers operating inside the trusted boundary can still
receive the complete ordinary action outcome.

Frame size/count, idle time, process lifetime, response size and request timeout are bounded.
Success, failure, malformed input, EOF, signals and output-pipe failure all reach a finally-owned
finish attempt using the retained direct sponsor. Signals do not abort admission mid-response and
lose its run id. A lost creation response or SIGKILL cannot be made transactional by a client:
cleanup remains explicitly unconfirmed and server expiry is the backstop, never reported success.

## Floor admission: existing SDK pillar

- **Bootstrap circularity:** an external principal must obtain and activate its action credential
  before it can invoke installed plugin behavior. Placing the transport/run owner in a plugin
  would require admission through the very runtime the external caller has not entered.
- **Neutrality:** ordinary action names and argument/result schemas come only from live discovery.
  The only fixed names orchestrate the existing reserved identity lifecycle; they do not select
  favorite application plugins or bypass the server's `runAccess` and authority declarations.
- **Arbitration:** the runner owns the secret-bearing process boundary and bounded invocation
  sequencing for every plugin. Plugins neither own sponsor secrets nor get to intercept another
  plugin's action call. Authorization and durable tracing remain in the existing server ladder.

`REGISTRY.md`'s SDK pillar indexes this addition; it adds no pillar or device-local UI state.
The protocol pillar owns the strict JSONL request/response schemas and published HTTP header names.

## Alternatives and dependency assessment

- **Separate CLI HTTP or generated per-plugin bindings:** rejected; duplicates transport and
  compatibility behavior, and becomes stale when a plugin is installed. The server remains the
  one argument validator; delivered JSON Schemas are not reimplemented as a second evaluator.
- **Harness/MCP first:** rejected as an additional control plane. A future adapter must wrap this
  same runner contract and lifetime rather than holding a parallel bearer/action implementation.
  An MCP SDK would add tool routing and protocol dependency without removing the Manifold-specific
  admission, acknowledgement, attenuation or cleanup state machine implemented here.
- **Commander/yargs:** no command grammar exists to justify an argument-parser dependency: argv is
  empty or `--help`; the typed interface is JSONL, validated with the already-present zod package.
- **Node readline in production:** it buffers a whole line before delivering it, so an adversarial
  unterminated frame can allocate before the limit is checked. A byte-bounded loop over the runtime's
  existing stdin iterator is the small required framing mechanism, not a new general parser.
- **Return raw action results and sanitize selected fields:** rejected; plugins can place secrets
  in arbitrary strings or output under an unknown key. The bounded runner publishes an allowlisted
  mechanical outcome instead. The shared transport itself preserves full UI/SDK compatibility.

No new third-party dependency is introduced. Plugin-kit gains a workspace edge to the SDK it now
uses instead of maintaining its former action fetch implementation.

## Evidence boundary

Focused tests cover shared session/headless transport behavior, authenticated live discovery,
exact policy admission and re-ack, real HTTP trace-to-ledger correlation, child creation/renewal,
credential-frame rejection and executable teardown on normal completion, failure, EOF, malformed
input and signals. This implementation branch intentionally does not execute validation; the
integration owner runs it after the independently owned #557 changes land. Tests are not a claim
of deployed verification or of protection against a hostile process sharing the launcher's OS user.
