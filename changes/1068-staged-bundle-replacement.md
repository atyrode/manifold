---
section: Added
issue: 1068
---

A hub can now cross to a new plugin protocol together with the installed plugins that protocol would hold. The deployment stages whole replacement bundles for the same plugin ids, each pinned by digest, and the new hub installs them at startup, before it serves or wires native execution. Grants, installer lineage, enablement and plugin data carry over. A replacement that widens capabilities, changes the data major, carries an unknown or future stamp, or would leave another bundle held is refused, and a refusal changes nothing. When a replacement changes a plugin's native declaration, the operator must acknowledge it. That plugin's native deployments are then stopped at their approved revision until the deployment review admits the new one. Rolling back restores the previous bundles and re-enables exactly those deployments. `docs/SELF-HOST.md` §Environments describes the procedure.
