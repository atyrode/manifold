---
section: Added
issue: 853
---

An exited terminal tile now says when the machine's terminal owner ended it rather than the terminal's own program: it adds one sentence beside Restart when the owner stopped, when that stop followed an out-of-memory kill in the owner's own cgroup on Linux, or when a replacement owner took over and could not carry the old terminals. Terminal listings and exit events carry the same `exitReason`, it survives hub restarts, and an ordinary shell exit reads exactly as before. A terminal the owner ended is kept even when its shell happened to exit with code 0. This is machine protocol 44: upgrade the hub before transports; older transports stay admitted and report exits without a reason, and a running terminal owner reports reasons only after it is next started from this release.
