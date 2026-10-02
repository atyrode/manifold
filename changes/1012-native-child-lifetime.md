---
section: Fixed
issue: 1012
---

Native jobs posted from a settled-job wake now keep running after the initiating hook returns instead of being cancelled before work begins. Durable credential, action, grant and native-consent checks still withdraw authority, and returned hooks cannot admit new jobs; the held/returned-hook smoke and withdrawal regressions prove the boundary.
