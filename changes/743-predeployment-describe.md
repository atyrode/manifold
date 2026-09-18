---
section: Fixed
issue: 743
---

A plugin asking about a machine it holds no installation on is answered again instead of refused `job_installation_absent`. Requiring an installation's revision-bound `machines:run` consent for every plugin-handle machine read demanded a consent for the one question that is asked before anything exists to consent to — "can I be deployed here?" — which is exactly what the pre-deployment answer reports, and it broke the door that asks it. Where no installation exists, `describe` now answers under `machines:read` and a grant reaching that machine alone, returning a null installation, no retained revisions, no consent rows and the plugin's own declaration. Where an installation does exist nothing changes: absent, disabled and wrong-capability consents each still refuse by their own name, and naming an installation revision that resolves to nothing still refuses rather than reaching the pre-deployment answer.
