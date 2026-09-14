---
section: Changed
issue: 574
---

Deployment now requires successful full verification for the exact revision being deployed, rather than treating a fast pull-request check or a published release as sufficient proof. Shared PR previews require an explicit full CI run on their current branch before deployment; stopping a preview remains independent of CI. Ordinary pull requests use a required fast baseline with dependency-selected risk checks, while full main verification runs asynchronously and routes failures to owned repair issues.
