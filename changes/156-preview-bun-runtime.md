---
section: Fixed
issue: 156
---

Preview development environments use Bun 1.4.2, preserving caller-owned subprocess descriptors instead of closing them during child cleanup. The environment remains pinned to a tested, anonymously pullable multi-platform image; production is unchanged.
