---
section: Added
issue: 810
---

A plugin can inspect a governed input's sealed digest, byte count and file count before reviewing an execution, without reading its content or acquiring authority to run it. The metadata-only `jobs.inspectInputs` method uses the same current source, export and read-consent checks as native admission; another plugin cannot inspect an unexported output, and a successful review does not survive withdrawn consent as an execution grant. Hardened contract 4 exposes the same operation to isolated plugins while preserving earlier supported guest contracts.
