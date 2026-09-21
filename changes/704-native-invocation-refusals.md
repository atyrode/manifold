---
section: Fixed
issue: 704
---

Native job invocation replies now name the admission or reservation check that refused them instead of collapsing distinct failures into `forbidden` or `invocation_refused`. Unexpected exceptions and unsafe or oversized messages remain private, and sandboxed service HTTP responses keep their existing privacy projection.
