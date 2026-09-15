---
section: Fixed
issue: 616
---

Hub restarts re-admit enabled native instance services without changing installation revisions or enablement, including when an owner's previous workload has already ended. Compatibility holds preserve installation intent while refusing unavailable execution, and lifting a hold restores the same native revision. Development deployments and production promotions now require five-minute live-state verification after switching: previously ready installations keep their revisions, enabled services return ready, and installed plugins answer declared read doors. Failed verification names the divergent item and automatically restores and verifies the previous application revision while leaving the deployment run failed; the installed-bundle bootstrap exception never bypasses this check.
