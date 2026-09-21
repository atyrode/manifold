---
section: Fixed
issue: 745
---

A plugin describing its purge-requested machine installation now receives `job_installation_purged` instead of a misleading consent refusal. Live installations retain their distinct absent and withdrawn consent reasons, undeployed plugins keep the pre-deployment answer, and operator reads still expose the retained installation state.
