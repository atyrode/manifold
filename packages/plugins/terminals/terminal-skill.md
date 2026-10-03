---
name: manifold-terminal
description: Discover and use core remote terminals from an ordinary Manifold terminal, without an OMP plugin or browser relay. Use when a task involves Manifold machines, remote commands, or inherited MANIFOLD terminal context.
---

Run `manifold context` for the installed client's current operating instructions, then
`manifold doctor` for secret-free binding and protocol diagnostics. Do not print environment
values or read another principal's credentials. A missing executable is an installation
problem, not proof that core terminal access is unavailable.

Ordinary terminal-local access uses the process's existing terminal-lifecycle identity;
external Agent/Run automation uses `manifold-action-runner` and its delivered policy instead.
Do not create a Run or request a human credential to replace a valid terminal binding.

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

A CLI-authored `manifold: <code>: <message>` diagnostic with status 255 reports refusal,
timeout, output bounds, lost connection, unknown completion, unconfirmed cleanup, or local
stdout/stderr that failed or did not drain within 10 s. A remote command can also exit 255
and print diagnostic-looking text: use `--receipt <path>` to distinguish its authoritative
ordinary exit from a CLI failure. Read the code and never replay automatically. A stopped
run's command gets TERM and then KILL through its process group; receipts retain trace and
cleanup evidence.
`manifold exec --machine <target> -- <program> <arguments...>` only when a structured JSON
envelope is wanted; check its completion and cleanup receipt, since uncertain completion is not
success. Targets need a Unix shell, including WSL, with `stty`, `od` and `dd` (and `base64` to
forward stdin); terminal control does not grant Windows desktop or game control.

## Optional native OMP tool

The Nix `manifold` package also exports `share/omp-tools/manifold-ssh.ts`. Opt in by linking
or copying that single artifact into OMP's filesystem tools directory (`~/.omp/agent/tools/`
globally or `.omp/tools/` for a project). No npm host SDK dependency, OMP plugin, MCP relay or
configuration activation is required by the artifact.

When the process has a valid ordinary-terminal binding, it registers the essential
`manifold_ssh` tool with `target`, one literal `command`, optional UTF-8 `stdin`, `timeoutMs`
and `maxOutputBytes`. The installed CLI remains authoritative for limits and admission;
absent stdin uses `-n`, and this tool never requests a TTY or escapes/joins the command.
For WSL, keep PowerShell dollar expressions inside the literal command. Native Windows is
not supported. The local `context --json` registration probe does not contact the hub:
offline or protocol-incompatible bindings still register, then receive the CLI's real refusal.
Missing, invalid, Agent/Run and mixed carriers omit the tool without an ordinary loader error.

Results keep stdout and stderr separate and preserve the CLI receipt, trace IDs and cleanup.
An authoritative ordinary remote exit from 0 through 255 is a result, including nonzero
statuses. Refusals, limits, unknown completion and unconfirmed cleanup are tool errors.
Cancellation signals only the local CLI and waits for its independent remote cleanup and
output drain; the completed error response retains the final receipt instead of discarding
structured evidence after an abort. No signal alone proves remote cleanup, and no error is replayed.
Unknown/offline target errors may suggest caller-visible online machine IDs/names; visibility
does not prove shell admission. Restricted OMP sessions skip filesystem discovery and do
not implicitly inherit this tool. SDK opt-in requires both `allowRestrictedCustomTools: true`
and explicit selection of `manifold_ssh`.
