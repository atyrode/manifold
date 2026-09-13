---
section: Added
issue: 547
---

A machine operation can now declare how many of its own jobs one machine may run at once, and the hub refuses the run that would exceed it instead of letting a caller size the fan by guess. A controller that launches many runs at a time is bounded by the operation's author: once the declared number are still unsettled on that machine, the next run is refused with `concurrency_limit` and the refusal is recorded with the run, and the moment one of them finishes the next run is admitted. The ceiling binds every way a run is posted, a scheduled occurrence and a nested invocation as much as a plugin's own request, and operations that declare no such ceiling behave exactly as before. The native owner protocol moves with this release — an installed operation now carries that declaration to the machine, and a running job now reports its own stage — so a machine still on the previous agent keeps its terminals but runs no jobs until it is upgraded.
