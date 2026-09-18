---
section: Fixed
issue: 762
---

A retained replacement is no longer refused by a process that had already exited. A process fingerprint — `cmdline`, `exe`, `environ` — needs ptrace-level access; `stat` does not, and `stat` is the whole of the exit question. The probe refused at the denial and so never asked it, which is how the integrated preview came to refuse its own verification harness: the hub runs as root there while the harness's reads run as another uid, and a container's root has no `CAP_SYS_PTRACE` by default, so it may read that process's `stat` and command line but not its fingerprint. Refusing a finished process is the mistake that made a permitted rollback fail in #699, reaching the same place through a different errno. Fail-closed is unchanged: only an exit the kernel confirms is admitted, a reused PID still refuses, and a process that stays alive and unreadable still refuses with the word for what happened.
