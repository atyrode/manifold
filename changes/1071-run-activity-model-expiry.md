---
section: Changed
issue: 1071
---

A long harness session can keep its Agent Run attributed. `manifold-action-runner` and `ActionRunner` now budget activity at 1024 reports per Run lease, and each successful renewal starts a new budget, so a renewing Run keeps reporting instead of failing at report 1025. Binding to an adopted Run now reports the Run's current `expiresAt`, and every renewal still reports the next expiry, so a harness no longer needs its lease passed separately. `core.access.reportRunActivityV2` accepts an optional `model`, the model the harness session currently serves. The Run's own harness must confirm it through the new optional `ServerHarness.resolveModel` before it replaces `Run.model`, which the Agents Run view and `listRuns` then show. A model is refused when the harness does not serve it, when the caller is not the Run or its Agent runner, and when the harness, such as `external`, cannot resolve models. Hardened plugins pack contract 13 for this verb. The hub still admits contracts 1–12, and those harnesses have every reported model refused.
