---
section: Fixed
issue: 605
---

Linux jobs preserve the intended files and directories when passing descriptors into a sandbox, preventing intermittent named-output failures and broken parent/child output handoffs caused by descriptor-number collisions.
