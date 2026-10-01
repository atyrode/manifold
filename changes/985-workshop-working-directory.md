---
section: Fixed
issue: 985
---

The persistent development workshop now starts with a systemd-valid working directory, including checkout paths containing spaces. The launcher no longer quotes this path as an ExecStart argument, which caused systemd to refuse the generated user unit before the workshop could start.
