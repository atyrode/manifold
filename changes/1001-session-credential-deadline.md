---
section: Fixed
issue: 1001
---

Finite session credentials with long lifetimes no longer disconnect immediately when their remaining duration exceeds the platform timer range. Admitted sessions preserve the absolute credential expiry across bounded timer wakes and wall-clock rollback, without changing normal revocation or cleanup.
