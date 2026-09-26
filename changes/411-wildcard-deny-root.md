---
section: Breaking Changes
issue: 411
---

A minted `*` credential now loses root-only authority while any administered deny decides an engine capability for it anywhere in the workspace, including a deny at a single container and including tokens minted onto the owner principal. It can no longer open declared-`*` doors such as grant administration, plugin inventory and credential administration until the deny is removed, and it can mint no further credentials. Open sessions are re-evaluated on their next request without signing in again, and root authority returns when the deny is revoked. Class denials such as `any-human` now also narrow the owner principal's minted tokens. The raw owner key is unaffected: it remains the non-deniable recovery credential and can always remove the deny. Denies that decide nothing for a credential, such as a class deny overridden by that principal's own allow at the same node, or a deny naming only plugin capabilities, leave root authority in place. Ordinary capabilities outside the deny are unchanged.
