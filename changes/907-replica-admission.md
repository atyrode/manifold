---
section: Fixed
issue: 907
---

Ordinary promotion now refuses an unadopted replicated source crossing the v0.22.0 replica-guard boundary before changing provider settings. Operators can rehearse the exact candidate image with a read-only replica observer that validates sealed main and auxiliary databases without starting a hub or changing history; live writers and untracked history retain their existing admission refusals.
