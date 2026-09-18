---
section: Fixed
issue: 738
---

A refused retained hub replacement now says what its predicate means, and stops claiming things it did not observe. The process probe names each of fifteen distinct refusals, and both of its receivers reported all of them with one sentence — "retained incumbent has owning or unknown processes" — which is true of exactly one of them and is an affirmative claim about a process table even when the probe never ran. `docker exec` failing now reports that the probe could not be run rather than accusing the container of owning processes; a probe that exited without a verdict and a probe that answered outside its vocabulary no longer have each other's messages; and a classifier fault reads as a defect in the probe instead of a finding about the machine. The vocabulary lives in one data file both the deploy path and the CI harness read, and its first test asserts they answer identically for every predicate and every non-answer. Nothing is admitted that was not admitted before: each of these still holds the replacement, it simply says which doubt.
