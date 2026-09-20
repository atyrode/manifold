---
section: Breaking Changes
issue: 414
---

Automated preview plugin delivery now selects the hardened runner by default. Receiver and direct `preview.sh plugin` callers must pack and verify for that runner, or explicitly pass `--in-realm` for a trusted in-realm bundle; incompatible artifacts no longer receive accidental in-realm admission. Explicit `--hardened`, exact-byte SHA-256 pins and integrated-development targeting remain supported. The general plugin-kit installer keeps its in-realm default. Receiver credentials still delegate all receiver verbs and the in-realm exception; hardened selection is not publisher authentication or OS confinement.
