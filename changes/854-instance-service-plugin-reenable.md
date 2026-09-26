---
section: Fixed
issue: 854
---

An enabled native instance service now recovers after its provider plugin is disabled and enabled again, instead of staying `unavailable` with reason `cancelled` until its configuration revision changed. A plugin disable still revokes the plugin's native installation, and enabling the plugin alone still restarts nothing: the service reports `installation_disabled` until a reviewed deployment or install re-enables the same pinned installation, then starts one replacement job under the unchanged revision, traced as `readmitted` with `cancelReason: plugin_disabled`. Retired, revoked and disabled configurations stay final.
