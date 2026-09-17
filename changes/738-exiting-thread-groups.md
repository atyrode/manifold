---
section: Fixed
issue: 738
---

The integrated preview's retained-process probe no longer refuses a hub replacement because a process was in the middle of exiting. An exiting multi-threaded process releases its address space before the kernel reaps it, so its `cmdline` and `exe` vanish while it is still listed and even still running — the stock healthcheck does this on every run — and that state was refused outright. It is now watched to a bounded deadline and admitted only when the terminal single-threaded zombie or the empty PID is observed under an unchanged start time; a group with a sibling thread that outlives its leader still holds. The one `process-unreadable` token that answered for four different facts is gone: each read failure now says which way it failed, a live process that never finishes exiting says so, and a thrown value with no errno is reported as a classifier fault instead of masquerading as an unreadable process.
