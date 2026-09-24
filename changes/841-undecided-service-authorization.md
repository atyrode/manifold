---
section: Fixed
issue: 841
---

A service call the hub allowed is no longer refused `403 service_unauthorized` because the hub took more than five seconds to decide. The machine owner now waits for the decision until the call's own deadline. An authorization the owner could not settle gets a retryable status with its own word: `503 service_timeout` when the call's deadline passes, `503 service_unavailable` when the owner has no hub seat or is draining, and `429 service_busy` when too many authorizations are already pending. The owner logs these refusals with `stage: "authorization"`. Only a denial still returns `403`. Each authorization also walks the machine's runtime-tool trees once instead of twice.
