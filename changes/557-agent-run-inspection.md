---
section: Added
issue: 557
---
Agent rows in Sessions now open a compact inspector through the headless `core.access.inspectAgentRun` action. A separate bounded `core.access.listAgentRuns` summary discovers self/sponsor-authorized runs without exposing administrator credential references. Root retains workspace-wide inspection; legacy credential inventory and human controls keep their existing audience. Inspectable facts include purpose, scope, policy, credential/connection life, trace attempts, stable native references and cleanup, with unavailable origins and unsettled work shown honestly. Selected delegation/native effects require bounded, redacted declarations only after real input and authority admission. Metadata migration 36 prevents forged legacy payload fields from becoming trusted declarations. Viewer replacement clears privileged snapshots immediately; credentials, private arguments, environment, terminal bytes and retained output remain excluded.
