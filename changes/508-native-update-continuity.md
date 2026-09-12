---
section: Fixed
issue: 508
---

Bundle updates replace enabled plugin modules without disabling their dependencies or cancelling already-approved native services when the native declaration, artifacts and resource requirements are unchanged. Replacement preserves an intentionally disabled plugin, preflights the new composition and restores the previous module and migration state if admission fails, including hardened plugins. Changed native scope still stops native execution pending review; explicit disable and uninstall retain their existing authority boundaries.
