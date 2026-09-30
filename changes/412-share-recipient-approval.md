---
section: Breaking Changes
issue: 412
---
Remote shares now require the host to approve each guest principal and remote capability subset through `core.access.listShareRecipients`, `approveShareRecipient` and `removeShareRecipient`; a guest's local read permission no longer grants the share's full authority. `openDial` accepts optional requested caps and returns actual approved ticket caps and finite expiry. Narrowing or withdrawing a recipient fences its related tickets and derived authority without disrupting unrelated shares, and explicit reapproval does not resurrect revoked credentials. Retained pre-approval tickets are retired during migration, and older instance peers must upgrade before resuming.