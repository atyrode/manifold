---
section: Fixed
issue: 165
---

Server logs and the trace ledger now redact fields containing password, passwd, credential or passphrase, including nested fields and mixed-case names, so plugin action credentials no longer appear in either record.
