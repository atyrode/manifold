---
name: manifold-terminal
description: Discover and use core remote terminals from an ordinary Manifold terminal, without an OMP plugin or browser relay. Use when a task involves Manifold machines, remote commands, or inherited MANIFOLD terminal context.
---

Run `manifold context` for the installed client's current operating instructions, then
`manifold doctor` for secret-free binding and protocol diagnostics. Do not print environment
values or read another principal's credentials. A missing executable is an installation
problem, not proof that core terminal access is unavailable.

An ordinary terminal's own binding can inspect and control its existing terminal, but it cannot
start a shell on another machine: `manifold ssh` and `manifold exec` refuse with
`shell_spawn_not_delegated`. Remote commands need a finite shell-automation credential that a
human mints for one exact machine under **Sessions → Delegate shell automation**
(`docs/ENROLL.md`, "Delegate ordinary shell automation"). When you get that refusal, ask the
human for that delegation; never borrow another credential, use an owner key or register a Run
to get around it. External Agent/Run automation uses `manifold-action-runner` and its delivered
policy instead.

Use `manifold machines` to select an explicitly authorized, online target by ID or exact name.
Run ordinary remote commands with `manifold ssh <target> <command...>`, as you would with ssh:
options go before the target, the command words are joined and run by `/bin/sh -c`, remote
stdout and stderr arrive separately and byte for byte, and the exit status is the remote
command's. Piped stdin is forwarded (read to end of file first, 1 MiB by default,
`--max-input-bytes` to raise it); pass `-n` when the command needs no input and stdin is an open
pipe. By default the command's stdio are pipes, never a terminal, which is what Windows console
programs reached through WSL (`powershell.exe`, `cmd.exe`) need: do not add `-t` or piping
workarounds for them. Use `-t` only for a program that really needs a terminal; its stdout and
stderr are then merged raw terminal bytes, no stdin is forwarded, and it starts with SIGINT and
SIGQUIT ignored.
To avoid quoting a command twice (once locally, once by the remote `/bin/sh -c`), send the
script on stdin instead: `manifold ssh <target> sh -s <<'EOF'` … `EOF`.

Exit status 255 with one `manifold: <code>: <message>` line on stderr is a Manifold-side
failure (refusal, timeout, output bound, lost connection, unknown completion, unconfirmed
cleanup, or local stdout/stderr that failed or did not drain within 10 s), not the command's
status: read the code, and never replay automatically. A stopped run's command gets TERM and
then KILL through its process group.
`--receipt <path>` keeps the JSON result, including trace receipts and cleanup evidence. Use
`manifold exec --machine <target> -- <program> <arguments...>` only when a structured JSON
envelope is wanted; check its completion and cleanup receipt, since uncertain completion is not
success. Targets need a Unix shell, including WSL, with `stty`, `od` and `dd` (and `base64` to
forward stdin); terminal control does not grant Windows desktop or game control.
