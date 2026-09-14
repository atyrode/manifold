---
section: Breaking Changes
issue: 601
---

Event frames now require `plugin`, the originating plugin id. Event kinds are local to their declaring plugin, so independently installed plugins can share names such as `run_changed`; consumers matching bare kinds across plugins must qualify by `event.plugin`. Subscription topics are unchanged. Installed non-core plugins with assembly conflicts, and their required dependents, are held aside with a visible reason instead of preventing the hub from booting; enabling a held plugin refuses with that reason until compatible replacement resolves it. Conflicting new bundles are still refused at install, and core-manifest errors remain fatal.
