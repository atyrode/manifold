---
section: Added
issue: 824
---

Native jobs can write named sealed outputs without mounting the directory that backs them. An output-only location retains the existing write permission but exposes only the job's own output leases, not sibling results or the backing directory. Concurrent producers can seal independently, and older owners refuse the new declaration rather than weaken its isolation.
