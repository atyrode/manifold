---
section: Fixed
issue: 167
---

Event delivery shares the session channel's send bound of 256 queued frames or 1 MiB; events past it are dropped by name (`socket_backpressure`, with connection and topic) while the socket and its subscriptions stay live. Catch-up is a state read; room-channel traffic and other subscribers are unaffected.
