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
Use `manifold exec --machine <target> -- <program> <arguments...>` for bounded, owned command
execution. Check its completion and cleanup receipt; uncertain completion is not success and
must not trigger automatic replay. The remote launcher requires a Unix shell, including WSL;
terminal control does not grant Windows desktop or game control.
