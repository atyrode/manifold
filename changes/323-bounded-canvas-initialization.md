---
section: Fixed
issue: 323
---

Views no longer wait indefinitely for initialization while another view keeps their shared connection alive. Missing initialization is retried per view with a bounded deadline and a named failure if recovery is exhausted, without interrupting healthy sibling views. Session diagnostics now distinguish connection opening, channel joins, initialization sending, and closure without logging credentials.
