---
section: Added
issue: 823
---

Jobs can inspect and pin the exact instance service they will use, including its owning machine, configuration revision and policy digest. Execution and schedules retain those pins through admission and service use, refusing a replaced or reconfigured service even when its policy text is unchanged. Existing callers keep their current behavior; jobs requesting this guarantee require a compatible native owner.
