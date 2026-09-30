---
section: Changed
issue: 877
---

Shared terminals fit the smallest desired columns and rows across the controller's active writable views instead of letting devices overwrite one another's size. Hidden, departed and stale views stop constraining the grid, while the last shared size remains stable when no view participates. A keyboard- and touch-accessible size indicator explains which visible views limit each dimension without exposing private device information. Session clients update together; retained native terminal owners do not require a fleet restart.
