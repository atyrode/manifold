---
section: Added
issue: 185
---

Bearer-only callers can now create terminals through `core.terminals.create`, receive a durable terminal address after machine acknowledgement, observe it through existing indexes and events, and attach later without holding a session socket during creation.
