---
section: Fixed
issue: 1043
---

Preview authentication delivery documents no longer enter the app-shell cache or replay a browser identity while offline. Authentication routes and their encoded or physical aliases are network-only; ordinary offline navigation and the user-accepted app update flow remain unchanged.
