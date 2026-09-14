---
section: Fixed
issue: 594
---

Native service credentials are no longer shown as ordinary agent sessions. Sessions identifies each service and its owning machine, links to its configuration, and removes the casual Revoke control; revocation through Access also names the service and the configuration door to use, even for root. Enabled services with a proved owner automatically recover revoked or expired credentials without changing their policy, while disable, replace and uninstall remain intentional shutdown paths. Existing and historically identifiable service principals are reclassified without changing credential values or hashes; human sessions and Agents retain their existing behavior.
