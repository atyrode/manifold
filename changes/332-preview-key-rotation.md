---
section: Fixed
issue: 332
---

Preview sign-in follows the production authority's current verification key instead of keeping an obsolete key until the preview restarts. Fresh valid assertions continue working after authority key rotation; tampered assertions and unavailable verification keys still refuse admission.
