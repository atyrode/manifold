---
section: Changed
issue: 318
---

Stopping or replacing the hub is now a handover instead of a cold swap. On SIGTERM the server stops admitting new requests, answering them with `503` and `Retry-After: 1`, lets the work it already accepted finish, and seals its writer epoch as its final commit before it exits. A new server on the same local data directory waits for that seal before it opens the database. Two hub processes sharing one directory therefore never write it at once, and a replacement started early no longer adds its own start-up time to the gap. Every start logs the last writer epoch its database records and whether that epoch was sealed. An unsealed epoch is logged as a warning: it means a crash, or a replica restored from before that writer's last writes. A sealed epoch does not prove the database is the newest copy. The gap is shorter, not gone: requests during it are refused and clients reconnect as before.
