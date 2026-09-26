---
section: Changed
issue: 318
---

Stopping or replacing the hub is now a handover instead of a cold swap. On SIGTERM the server stops admitting new requests, answering them with `503` and `Retry-After: 1`, lets the work it already accepted finish, and seals its writer epoch as its final commit before it exits. A new server on the same data directory waits for that seal before it opens the database, so two hub processes never write one directory at once, and a replacement started early no longer adds its own start-up time to the gap. Every start logs whether its predecessor handed over cleanly, so a crash, or a replica restored from before the last writes, is reported instead of passing unnoticed. The gap is shorter, not gone: requests during it are refused and clients reconnect as before.
