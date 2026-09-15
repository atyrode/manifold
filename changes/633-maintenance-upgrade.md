---
section: Fixed
issue: 633
---

The first upgrade from older plugin packages can now use an explicit maintenance step while compatible replacements are installed, including hubs that predate native execution. It reports the affected plugins and native workloads without claiming they are healthy, preserves enrolled machines and unrelated deployment and rollback checks, and holds machine updates until ordinary verification passes.
