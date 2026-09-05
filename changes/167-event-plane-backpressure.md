---
section: Fixed
issue: 167
---

Event subscribers that cannot keep up now close with `outbound queue overflow` instead of letting the hub buffer notifications without bound. Event delivery shares the session channel's send limits; other subscribers continue receiving events normally.
