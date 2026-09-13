---
section: Added
issue: 513
---

A hardened plugin's server half can now register, list and disable its own job schedules, and a plugin's enable and disable hooks are handed the job authority their installer consented to. A background half that owns a cadence therefore starts it when it is turned on, instead of waiting for a dispatch or a settled job that may never arrive; when the installer's credential no longer restores, the slice is simply absent and the transition still completes.
