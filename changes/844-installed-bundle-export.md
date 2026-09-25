---
section: Fixed
issue: 844
---

Exporting the installed plugins with `engine.plugins.exportInstalled` no longer answers `500 internal server error` when an installed bundle is 6 MiB or larger, which is 8 MiB or more of base64. The export's bundle bytes are now checked in one linear pass instead of a whole-string pattern that stopped matching valid input of that size, so a deployment to an instance holding a large plugin passes its installed-bundles check again. The export still accepts only canonical padded base64, and now also refuses bytes that decode past the 16 MiB artifact cap the export reads.
