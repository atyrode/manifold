---
section: Fixed
issue: 841
---

Remote job-service calls no longer abort hub tunnel readiness after a fixed five seconds. They use the operation's existing deadline and cancellation/authority lifetimes, allowing a delayed hub answer to succeed while retaining timeout, cancellation and explicit-refusal behavior.
