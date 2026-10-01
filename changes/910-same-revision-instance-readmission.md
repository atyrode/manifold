---
section: Fixed
issue: 910
---

A single reviewed deployment can re-admit an instance-service provider and its consumers after plugin disable/re-enable even when the installation revision is unchanged. Disabled or purging providers outside the selected proposal remain refused, and owner acknowledgement and live service readiness are still required.
