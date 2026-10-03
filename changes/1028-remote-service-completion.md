---
section: Fixed
issue: 1028
---

Completed remote service responses no longer produce a misleading cancellation in the owner log and service trace when their one-use HTTP connection closes. Real client cancellation, authority withdrawal, tunnel errors and request deadlines retain their existing behavior and bounded cleanup.
