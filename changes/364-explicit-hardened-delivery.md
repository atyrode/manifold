---
section: Added
issue: 364
---

Plugin delivery through the preview receiver and operator CLI now accepts an explicit `--hardened` fourth word to select the existing hardened runner. The ordinary `plugin URL SHA256` form stays in-realm; unknown options and extra arguments are refused before installation.
