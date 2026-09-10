---
section: Fixed
issue: 461
---

The maintenance CLI regression that starts eight separate processes has an explicit 15-second test deadline so gate load does not kill a fixture child at the implicit five-second boundary. Malformed-input, secret-redaction and zero-hub-request assertions, fixture cleanup and the child watchdog are unchanged. Product behavior and timeouts are unchanged.
