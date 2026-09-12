---
section: Added
issue: 523
---

Installed plugins can declare real named storage migrations in their server export. Compiled and hardened guests run the same bounded storage-only contract: the engine drains that plugin, stages its rows privately, and publishes transformed data, the migration ledger, declared version and replacement metadata in one native transaction. Failed, timed-out or conflicting work keeps the previous runtime and data serving unchanged.
