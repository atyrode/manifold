# Security policy

## Reporting a vulnerability

Report privately, through this repository's **Security** tab → **Report a vulnerability**. That
opens a private advisory only the maintainers can read.

Never report a vulnerability in a public issue, pull request, discussion or comment. If you have
already published one, say so in the private report so the exposure window is known.

A useful report names the affected version or commit, the origin or deployment you observed it on,
what an attacker can do, and the smallest reproduction you have. Redact tokens, keys, cookies,
signed URLs and anything else that would hand over an account: the reproduction matters, the
credential does not.

> Private vulnerability reporting is a repository setting, and it is currently **disabled**. Until
> the owner enables it under Settings → Code security, the Security tab offers no private channel;
> ask the owner for a private contact rather than filing a public issue.

## What to expect

- **Acknowledgement** within 7 days, from a maintainer, in the advisory thread.
- **An assessment** — whether it reproduces, what it affects, and the severity we assign.
- **A fix**, shipped through `bun run release` like any other change, and described in the
  advisory when it is published. Severity maps onto the tracker's priorities as
  [`docs/TRIAGE.md`](docs/TRIAGE.md) §Priority rubric describes: critical is `p0`.
- **Credit** in the advisory, under whatever name you choose, unless you ask us not to.

There is no bounty program. We will not ask you to sign anything to report a bug.

## Supported versions

The latest published release, and `main`. Manifold is self-hosted: if you run an older tag, the
fix is an upgrade. Deployment and upgrade procedures are in
[`docs/SELF-HOST.md`](docs/SELF-HOST.md).

## Scope

This policy covers this repository's code and the deployments the maintainers operate. Testing
against someone else's instance, or any traffic that degrades one, is not authorized by it — run
your own instance, which takes one command.
