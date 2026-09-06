---
section: Added
issue: 166
---

Action handlers now receive `ctx.traceId`, the id of their write-ahead trace row returned by `core.events.list`, including across isolated-plugin dispatches. Plugin authors can link domain records directly to the trace authorizing the action without searching by door, principal or time.
