---
section: Fixed
issue: 926
---

Job starts refused by the machine owner now retain the owner's reason in their interrupted result, authorized job journal and settled callback instead of reporting `owner_refusal_unknown`. Lifecycle audit metadata remains redacted, and duplicate late refusals do not replace the recorded result.
