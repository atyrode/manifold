---
section: Breaking Changes
issue: 326
---

Ordinary agent credentials now expire after one hour, while human credentials retain their fourteen-day lifetime. Existing unbounded ordinary credentials receive a one-time migration grace period of one hour for agents or fourteen days for humans; the recovery owner key, machine enrollment, and credentials bound to running terminal lifecycles remain exempt. Automation must revoke its own credentials when finished, and public verification now removes its test terminals and fails if credential or resource teardown fails.
