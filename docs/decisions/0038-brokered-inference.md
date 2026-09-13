# A job that drives a model never holds the model's credential: inference is a metered Instance Service

Date: 2026-09-13
Status: proposed

## Context

Babel's `explore` and `evaluate` operations launch `code engine` inside their job sandbox, and the
engine's runs are model runs. Today that engine authenticates the way an interactive `code` does
(`code/omprpc.go:521-541`): it resolves an OMP auth-broker token, asks that broker for a provider
token, and calls the provider itself. Its sandbox allows exactly that egress - the provider
endpoint plus the auth broker (`code/sandboxegress.go:92-106`) - and then scrubs the credential out
of every byte the run writes (`code/babelworker.go:29-30`), which is the symptom of a run holding
something it should not. Inside a Manifold job there is nothing to resolve: the runner denies
network by default and inherits no daemon, hub or provider credential (ADR 0033), Babel's launch
inherits no provider or model variable on purpose (`babel/plugins/atyrode.babel/machine/engine/launch.ts:334-352`),
and ADR 0033 stopped at the line "Code retains ownership of its own model/OMP containment, tool
authority and provider-credential handling" (`0033-governed-plugin-runtime.md:35`). So no
governed run can reach a model, and the operator decided (atyrode/babel#255, 2026-09-12; manifold#530)
how it should: the job never holds a model credential; Manifold makes the calls on its behalf, one
credential held once, every call traced, budgeted and attributed to the job.

Most of that already exists, and this record is careful to say which half. An Instance Service
policy is owner-installed configuration naming an HTTPS origin and an owner-held credential
injected under a header the caller can never forward (`packages/protocol/src/services.ts:419`,
denylist at `:104-129`); an `http-proxy` operation forwards a declared route with a full-disclosure
JSON request and a streaming `application/json` / `text/event-stream` response (`services.ts:309-360`).
A job binds a service in its manifest and receives, through a private generated input file, a URL
on the machine owner's loopback and a fresh bearer minted for that one job
(`packages/agent/src/job-inputs.ts:48-72`, `packages/agent/src/job-owner.ts:1048`); the owner's
proxy (`packages/agent/src/job-service-proxy.ts:25-36`) resolves the credential, forwards the bytes
and never reads the body; the hub authorizes every call through the permission waterfall and writes
the trace first (`packages/server/src/job-service.ts:1349-1393`). Code's own gateway is exactly this
shape already (`code/plugins/atyrode.code/service-policies.ts:128-138`). What does not exist: a
ceiling in cost or tokens (`JobLimitsSchema` is time, memory, processes and output bytes,
`packages/protocol/src/jobs.ts:28-33`; `usage` mirrors it, `:424`), any reading of what a call cost,
a price the hub could turn tokens into money with, and a lane by which `code engine` speaks to the
owner's proxy instead of a provider.

"Hub-brokered" therefore names the authority, not the socket. The hub decides, records and
attributes; the owner process on the machine that runs the job holds the credential and carries the
bytes, as it does for every Instance Service. Moving the bytes through the hub would put every
model token through the control plane for no gain in custody - the owner is Manifold's process too.

## Decision

### 1. Inference is an Instance Service the owner installs, not a subsystem

There is no `engine.inference`. The owner installs a `ServicePolicy` whose origin is a provider (or
a local lane, or Code's gateway - the job cannot tell) and whose operations are `http-proxy`
routes over the OpenAI-compatible surface: `models` (`GET /v1/models`), `chat`
(`POST /v1/chat/completions`) and `responses` (`POST /v1/responses`), each streaming with full
disclosure, each bounded by the existing request and response byte limits. The credential is a
`credential.ref` the owner alone resolves. A machine whose owner holds no credential for the
service refuses at admission with the refusal that exists for it, `service_credential_unavailable`,
and Watch's dry preview says so before the button.

### 2. A proxy operation may declare a meter, and the meter is the only thing that reads a body

`ServiceProxyOperationPolicySchema` gains an optional `meter: { kind: "openai-usage" }`. A metered
operation's proxy reads exactly the `usage` object and the `model` field of a JSON response, or of
the final usage frame of an SSE stream - and, when the caller's request is a stream, sets
`stream_options.include_usage` so that frame exists. Nothing else of the body is read, kept or
logged; the content passes as opaque bytes exactly as it does today. The meter yields
`{ model, inputTokens, outputTokens, cachedInputTokens? }` per call.

A response the meter cannot read on a metered operation is `service_response_invalid`, not a free
call: a ceiling that could be evaded by a malformed usage frame is not a ceiling.

### 3. Prices live in the policy, ceilings live in the job, and both are the owner's numbers

The policy carries `prices`: a map from model id to `{ inputPerMillion, outputPerMillion,
cachedInputPerMillion? }` in integer micro-dollars, plus an optional `default`. Prices are policy
content, so they are hash-pinned by the policy's `revision` and consented like everything else in
it; a price change is a new revision and a new decision.

`JobLimitsSchema` gains an optional `inference: { calls?, inputTokens?, outputTokens?,
costMicros? }`, and the job record's `usage` gains the same four as totals. A request naming a
cost ceiling on a job whose bound inference operation has no price for the model a call names is
refused before the call, `service_price_unknown`: a ceiling in money is meaningless without a
price, and refusing is the answer the operator can act on.

### 4. The owner enforces, per call, before and after

Before forwarding, the proxy refuses a call that would exceed `calls`, and one arriving after a
token or cost ceiling has been crossed: `service_ceiling_exceeded`, HTTP 429, with the ceiling
named in the body. After the meter reads a call, the owner adds it to the job's running totals.
A call that crosses a ceiling mid-stream is not cut - the tokens are spent by then, and a run
that ends on a truncated answer produces records nobody can read - but it is the last call the job
gets. The overrun is bounded by one response's `maxResponseBytes`, which the policy already
states.

### 5. Every call is a journal event; the totals settle with the job

Each metered call appends `inference_call` to the job's journal: `{ model, inputTokens,
outputTokens, costMicros, elapsedMs, status }` - never prompts, never text - inside the journal's
existing 128-event ring. A ceiling refusal appends `inference_ceiling` with the ceiling that
refused. The job's settled record carries the totals in `usage.inference`, so `onJobSettled`
delivers them, and Babel's pulse ("$0.64 today") becomes a sum of facts the hub recorded rather
than of numbers the engine reported about itself.

### 6. Code gets a brokered lane, beside the local one

`code engine` already has one keyless configuration: a local-lane profile runs against an
endpoint on the machine that takes no key (`code/ompinvestigator.go:1160-1173`). A brokered
profile is the second: its endpoint is the URL and its bearer the token the generated input file
delivered, and the run's egress allows that loopback and nothing else. OMP already speaks to an
OpenAI-compatible base URL, so the engine changes in exactly one place - where it resolves what to
authenticate with - and the scrub set gains the job's bearer instead of a provider token. A
profile that is neither local nor brokered is refused inside a governed job, so the fallback to
the auth broker cannot quietly happen where it cannot work.

### 7. Babel binds the service, and Watch shows the numbers that will be true

`explore` and `evaluate` declare the service binding and the generated input file, splice the
endpoint into the runtime document the engine already reads, and pass the operator's ceilings
through as `limits.inference`. `launchPreview` reads the policy's prices for the profile's model
and the job's ceilings, so the profile, model, cost and ceilings it shows before the button are
the ones the owner will enforce, and the receipt after it carries what the journal says was spent.

## Refused alternatives

**Vend provider tokens to the job (today's shape).** The run holds a credential that reaches the
provider directly; its ceiling is whatever the provider's account allows; and the token must be
scrubbed from every diagnostic, which Code does and which is the sign the token should not be
there. Attribution of spend to a job becomes a reconstruction from provider dashboards.

**A hub-side inference process that carries the bytes.** Custody is no better - the owner is
Manifold's process - and every token crosses the control plane, which is the wrong place for a
256 MiB streaming response. The hub's role is authority and record, and that is where this record
keeps it.

**Meter by counting tokens ourselves.** A tokenizer per model, maintained beside the provider's,
disagreeing with the bill. The provider's `usage` object is the number the invoice is built from;
forcing `include_usage` on streams makes it always present.

**Cut a stream at the ceiling.** Saves at most one response, costs a truncated answer that
produces unreadable records, and the provider bills the tokens anyway.

**Put prices on the job request.** A caller naming its own prices names its own ceiling. Prices
are the owner's, pinned in the policy's revision, decided like the rest of it.

## Consequences

- Protocol: `meter` and `prices` on the policy, `inference` on `JobLimitsSchema` and on `usage`,
  three refusals (`service_ceiling_exceeded`, `service_price_unknown`, and the existing
  `service_response_invalid` gains the unreadable-usage case), two journal events. All additive;
  a policy without `meter` and a job without `limits.inference` behave exactly as today.
- Agent: the proxy reads usage on metered operations only, keeps per-job totals, refuses at the
  ceiling, and reports each call to the hub with the trace it already writes.
- Server: journal events, `usage.inference` at settle, and a read the preview can use for prices.
- Code: the brokered lane; refusal of any other lane inside a governed job.
- Babel: the binding, the splice, the ceilings, the preview and the receipt.
- The `omp-auth-broker` remains what interactive Code uses; nothing here retires it.

## Evidence

Accepted when: a Babel `explore` job on a machine whose owner holds the credential completes a
run with `usage.inference` non-zero and one `inference_call` per model call in its journal; the
same job on a machine without the credential is refused at admission and Watch's preview says so;
a job with `costMicros` below one call's price is refused `service_price_unknown` when the model
is unpriced and `service_ceiling_exceeded` on its second call when it is; and no byte of the
provider credential or of any prompt appears in the trace, the journal or the job's output.

## Revisit when

A provider stops reporting usage, a second wire shape (non-OpenAI) needs a second meter kind, or
the operator wants a ceiling per day across jobs - which is a policy fact, not a job fact, and
would live beside `prices`.
