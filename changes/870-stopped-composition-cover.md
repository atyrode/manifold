---
section: Fixed
issue: 870
---

A composition whose session ended before its first layout arrived no longer says it is still connecting. Its cover keeps progress wording only while the view is connecting or reconnecting on its own, and a reconnectable drop still recovers without a reload. A closed view says it is disconnected, names the reason the session reported — the same reason as its connection notice — and offers a reload to connect again.
