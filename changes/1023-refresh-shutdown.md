---
section: Fixed
issue: 1023
---

Fast Refresh development sessions now exit cleanly when stopped during a dependency lookup, instead of reporting completed cleanup while a late filesystem watcher keeps the process alive.
