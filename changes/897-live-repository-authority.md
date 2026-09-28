---
section: Fixed
issue: 897
---

Plugins can no longer read repository metadata through an undeclared or withdrawn machine-read capability. Native and hardened repository queries now recheck the live caller, action declaration, installation grant and `machines:read` authority at the requested machine before observing it. Refused queries reveal no path existence, repository identity or origin; authorized machine-specific grants continue to work.
