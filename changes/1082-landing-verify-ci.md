---
section: Changed
issue: 1082
---

The landing concept lab's browser checks now run to the end after a failure, listing every failed check, and relaunch the browser after a lost page or an overrun deadline instead of giving up on the rest; no check is run again. A pull request confined to some scenes now also narrows the checks that walk every scene to those scenes, and the CI shards weigh those checks by that share, while the passage-speed check is split in four. Every registered check has recorded seconds, and a test keeps the registry and the records in step. CI writes each shard's per-check seconds and the browser version to the job summary, runs the browser checks on a pinned Chrome for Testing with a shallow checkout and no package install, adds the lab's GLSL check and node for the countryside's cross-engine test, and offers an advisory A/B render of a canary set of scenes and their knob turns (`ab.ts --turns`). A table-driven test holds every headless scene simulation to playing the same at 60 and 144 frames a second, listing its few exemptions with their reasons, and the checks share one verify kit for their common helpers. Renders are unchanged.
