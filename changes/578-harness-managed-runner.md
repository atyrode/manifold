---
section: Breaking Changes
issue: 578
---

The action runner no longer accepts a model-authored `start` frame or `MANIFOLD_SPONSOR_TOKEN`. Trusted launchers bind an existing Agent with `MANIFOLD_AGENT_ID` and its scoped `MANIFOLD_RUNNER_TOKEN`, or adopt an admitted run with `MANIFOLD_RUN_ID` and `MANIFOLD_RUN_TOKEN`; both modes withdraw their environment carriers before reading model input. Admission delivers discovery and exact policy automatically, child runs stay under the same Agent, and harness activity uses a separate bounded pipe rather than model JSONL. Update orchestrator launch environments before upgrading; ordinary action frames, explicit policy acknowledgement and redacted results remain unchanged.
