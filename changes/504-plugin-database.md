---
section: Added
issue: 504
---

A plugin whose data is rows rather than settings can now declare `database` in its manifest and keep its own SQLite file, reachable as `ctx.database` with `query`, `run` and `batch` — one contract for in-realm and hardened plugins alike, bounded by stated limits and refused as rejections. A `batch` is the transaction: its statements commit together or roll back whole. An in-realm migration receives the database beside storage (a hardened guest makes its tables in `onEnable`), the plugin keeps one data version and one ledger, a disable retains the file, an uninstall refuses while it still holds pages, and a purge deletes it and reports the bytes it removed.
