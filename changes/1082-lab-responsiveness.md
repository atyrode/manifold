---
section: Fixed
issue: 1082
---

In the landing concept lab, a long slider drag no longer leaves the address bar on a stale setup. The browser used to ignore address updates after about two hundred in a few seconds, so reloading or sharing restored an earlier setup; Firefox and Safari could also stop the drag partway. The address now updates a few times a second, always ends on the final setup, and the copied link is built from the setup itself. Switching scene no longer waits for a background shader build left over from the previous scene, and unchanged controls are no longer rewritten on every input.
