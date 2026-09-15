---
section: Fixed
issue: 625
---

Deployment live verification no longer refuses a switch because an installed plugin declares no argument-less read door. Such a plugin is verified through its roster row (present, enablement unchanged, not held, healthy lifecycle); plugins with an argument-less read door are still probed through it.
