---
section: Fixed
issue: 322
---

Realtime connection failures now include a non-secret session and channel correlation ID, close code, and bounded reason so operators can match a browser failure to its server lifecycle events without exposing credentials or content.
