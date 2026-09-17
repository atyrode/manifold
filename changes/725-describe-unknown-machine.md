---
section: Fixed
issue: 725
---

`engine.jobs.describe` now refuses `machine_unknown` for an identifier that matches no enrolled machine, instead of answering `connected: false` with no installation for it. A caller holding a machine's name rather than its id used to be told that a connected machine was offline, indistinguishable from the truth about an enrolled machine that is genuinely disconnected — which is still exactly what such a machine answers.
