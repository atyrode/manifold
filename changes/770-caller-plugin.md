---
section: Added
issue: 770
---

Plugin action handlers can read the verified immediate caller plugin from `ctx.callerPlugin`, or `null` for direct calls. Hardened plugins packed with contract 8 receive the same identity; older bundles remain compatible.
