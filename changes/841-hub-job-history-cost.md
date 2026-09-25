---
section: Fixed
issue: 841
---

The hub's routine job bookkeeping no longer grows with the finished jobs it retains. Its once-a-second job tick, each machine-owner resource or installation report, each authority change and each cancellation used to read every job the hub had ever run. With a few thousand retained jobs, each of those reads held the hub for about a tenth of a second, and it could not answer service authorizations or `/healthz` in that time. They now read only live jobs and pending scheduled runs, so they cost the same with twenty thousand retained jobs as with one thousand. This is not the whole of the multi-second pause that follows a session post, which is still being investigated.
