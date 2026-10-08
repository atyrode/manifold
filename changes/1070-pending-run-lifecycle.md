---
section: Changed
issue: 1070
---

A Run that has not yet acknowledged its policy can now report harness activity and renew itself with its own credential, through `core.access.reportRunActivityV2` and `core.access.renewAgentRunV2`. A harness whose model has no Manifold tool, such as an interactive terminal session, can therefore keep its Run alive and show its activity before the model acknowledges. Renewal still requires a justification and keeps its lease bounds and renewal ceiling. Every other action, including the earlier `reportRunActivity` and `renewAgentRun`, still waits for acknowledgement, and another Run's credential cannot renew or report for it. `manifold-action-runner` in Run mode accepts `renew` before `ack` to match; Agent-mode roots and children still renew only after acknowledgement.
