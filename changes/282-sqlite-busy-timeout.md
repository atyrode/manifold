---
section: Fixed
issue: 282
---

The server now waits up to five seconds for SQLite write locks, so brief Litestream checkpoint collisions no longer interrupt attendance writes or terminate the server.
