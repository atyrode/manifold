---
section: Fixed
issue: 586
---

Native jobs can write to declared runtime directories on a freshly mounted output filesystem without manual directory creation. Missing declared directories are created privately and reused on later jobs, while exclusive creation, state-backed locations, exact-file access and bounded named-output storage retain their existing safeguards.
