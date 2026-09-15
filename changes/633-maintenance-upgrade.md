---
section: Fixed
issue: 633
---

The first upgrade from older plugin packages can now use an explicit maintenance step while compatible replacements are installed. It reports the affected plugins and services without claiming they are healthy, preserves unrelated deployment and rollback checks, and holds machine updates until ordinary verification passes.
