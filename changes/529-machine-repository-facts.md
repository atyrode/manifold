---
section: Added
issue: 529
---

A plugin can ask an enrolled machine what repository a folder on it is, without being handed the
host's filesystem. `engine.machines.repository { machineId, path }` — `ctx.machines.repository`
for an in-realm plugin and its promise counterpart for a hardened one — answers the resolved git
common directory and the `origin` remote normalized to `host/owner/repo`, or the reason there is
neither: the folder is not a checkout, is absent, is unreadable, the host has no git, or the probe
ran out of its second. A checkout and a linked worktree of it answer with the same identity, so
one project reached through two folders is recognisable as one. Authority is the new
`machines:read` capability asked at `manifold://machine/<id>`, so a token entitled to read one
machine cannot read another's folders, and every ask is traced without the folder entering the
ledger. The agent probes read-only and bounded — one second, no index lock, no credential prompt,
no network — and caches each path for a minute, and a machine that cannot be asked says so instead
of answering with a repository nobody observed.
