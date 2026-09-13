---
section: Fixed
issue: 524
---

Development and verification now order supplied bundles by their declared required dependencies as well as namespace parents. Duplicate ids and dependency cycles refuse the batch before installation; absent dependencies remain for the hub to judge. Successful cleanup uses the exact reverse order, so cross-family clients no longer block removal of their prerequisites.
