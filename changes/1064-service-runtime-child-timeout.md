---
section: Fixed
issue: 1064
---

A job can now use a job-scoped service whose provider declares a longer timeout than the job itself. The hub used to give the service's runtime its provider's full declared timeout, which the native owner refuses for any parent with less time left, so every call to that service failed after a 30-second start timeout. The runtime now gets the provider's declared timeout or what the parent has left after its earlier nested jobs, whichever is shorter. With nothing left, the start is refused at once as `invocation_timeout_budget_exhausted`. A workload's explicit invocation keeps its callee's declared timeout.
