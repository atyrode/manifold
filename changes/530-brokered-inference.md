---
section: Added
issue: 530
---

A job that drives a model no longer holds the model's credential. Inference is an ordinary Instance
Service now: the machine owner installs a policy whose origin is a provider and whose operations are
the OpenAI-compatible routes, the job binds it in its manifest and receives a loopback URL and a
bearer minted for that one run, and the owner makes every call with the credential only it can
resolve. A proxy operation may declare `meter: { kind: "openai-usage" }`, which is the one thing
that reads a body: the provider's own `usage` object and the model it names, from a JSON response or
from the final usage frame of a stream the owner asked to include one — never a prompt, never a byte
of the answer. The policy carries `prices` per model in integer micro-dollars, so a call's cost is
the owner's number pinned by the policy's revision rather than an estimate; a job request carries
`limits.inference` in calls, input tokens, output tokens or micro-dollars, and an operation that
declares a ceiling keeps it when a caller names none and refuses a caller that tries to raise it.
The owner enforces before forwarding — a call that would pass a ceiling is refused with HTTP 429 and
`service_ceiling_exceeded` naming the ceiling, and a cost ceiling over a model with no price is
refused with HTTP 422 and `service_price_unknown` — so a stream is never cut mid-answer and a
truncated answer is never produced by a budget. Every metered call appends `inference_call` to the
job's journal with its model, tokens, cost, elapsed time and status, every refusal appends
`inference_ceiling` with the ceiling that refused, and the settled job's `usage.inference` carries
the totals, so what a run spent is a fact the hub recorded rather than a number the run reported
about itself. The plugin manager's run history shows those calls and the totals beside the job's
other usage.
