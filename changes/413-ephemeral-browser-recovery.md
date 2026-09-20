---
section: Fixed
issue: 413
---

Browsers no longer retain the non-expiring recovery key after bootstrap. Recovery links are captured only for the current page, and legacy saved keys are removed without clearing ordinary identities or workspace data. Reload continues with the finite identity credential; interrupted bootstrap or an unusable standalone identity requires reopening the recovery link, while configured preview admission still uses production sign-in.
