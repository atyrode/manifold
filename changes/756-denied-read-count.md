---
section: Changed
issue: 756
---

A retained-process refusal says how many reads the kernel refused, which is the one question the predicate could not answer: `fingerprint-unreadable-denied` reads the same whether one hardened process denied a look or the probe may not read the container at all — a same-uid process that clears its dumpable flag denies `exe` and `environ` exactly as another user's process does — and those want different repairs. The count is all that was added, deliberately: the probe already holds a process's command line when it refuses, so this was a decision about what a safety gate may disclose about a retained environment rather than a limit on what it could see, and the decision was a count, never a pid, name, path or argument. Both receivers report it in the same sentence, and a receiver handed a field it cannot parse says it reached no verdict instead of quietly dropping the part it did not understand.
