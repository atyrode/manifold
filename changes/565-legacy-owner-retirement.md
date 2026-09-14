---
section: Fixed
issue: 565
---

A drained machine can now finish already-cancelled retained jobs when its protected native owner predates the hub’s current job RPC. The exact pinned owner receives retirement only; it remains unavailable for new jobs, installations, services, resources, input, output, and readiness until the normal empty-owner replacement completes.
