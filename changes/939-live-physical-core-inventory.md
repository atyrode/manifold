---
section: Added
issue: 939
---

Machine inventory now reports `physicalCoreCount` when a connected Linux agent can observe its online physical package/core topology. SMT siblings count once, separate packages remain distinct, and unavailable topology stays unknown rather than falling back to logical CPUs or quotas. The observation refreshes on reconnect and disappears on disconnect or withdrawal. Authorized in-realm and hardened readers receive the same live metadata; older compatible agents remain connected without a count, and older packed plugins retain their supported inventory shape. Upgrade the hub before newer transports.
