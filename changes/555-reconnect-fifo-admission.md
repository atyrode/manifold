---
section: Fixed
issue: 555
---

Queued machine jobs now resume in durable FIFO reservation order, so reconnecting at an operation's concurrency ceiling admits the earliest work and durably refuses only later excess reservations.
