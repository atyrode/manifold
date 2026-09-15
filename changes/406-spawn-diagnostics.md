---
section: Fixed
issue: 406
---

Machine-local terminal creation diagnostics no longer mislabel every missing launch path as a missing program: ambiguous runtime errors name both the program and working-directory possibilities, while clients retain the generic creation failure.
