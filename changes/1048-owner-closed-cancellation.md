---
section: Fixed
issue: 1048
---

A native job that was cancelled after its owner had already closed the workload, but whose result never reached the hub, no longer stays active forever: on reconnect the hub asks the owner for the retained result instead of replaying the cancellation, and an owner answering such a cancellation now returns that result too. Previously the record held its installation busy, so every later deployment of the plugin on that machine waited indefinitely.
