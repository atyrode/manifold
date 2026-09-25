---
section: Fixed
issue: 841
---

The hub no longer slows down as it retains more finished jobs. Its once-a-second job tick, each machine-owner resource or installation report, each authority change and each cancellation used to read every job the hub had ever run, so with a few thousand retained jobs that work alone kept the hub busy for a tenth of a second at a time and delayed service authorizations and `/healthz`. Those reads now touch only live jobs and pending scheduled runs, and cost the same at twenty thousand retained jobs as at one thousand.
