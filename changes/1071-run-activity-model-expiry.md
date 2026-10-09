---
section: Added
issue: 1071
---

A long harness session can keep its Agent Run attributed. `manifold-action-runner` and `ActionRunner` now limit activity to 1024 reports per owned Run until its next successful renewal, instead of 1024 for the runner's whole life, so a renewing Run keeps reporting. Binding to an adopted Run now reports the Run's current `expiresAt`, and every successful renewal reports the next one, so a harness no longer needs its lease passed separately. `core.access.reportRunActivityV2` accepts an optional `model`, the model the harness session currently serves. The Run's own harness must confirm it through the new optional `ServerHarness.resolveModel` before it replaces `Run.model`, which the Agents Run view and `listRuns` then show. A model is refused when the harness does not serve it, when the caller is not the Run or its Agent runner, and when the harness, such as `external`, cannot resolve models. Hardened contract 13 carries the verb: every plugin packed with this release's kit stamps 13 and needs a hub from this release or later. The hub still admits contracts 1–12, and those harnesses have every reported model refused.
