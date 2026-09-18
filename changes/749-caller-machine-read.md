---
section: Changed
issue: 749
---

A token that reads a machine through a plugin door must now hold `machines:read`, and narrow capability lists written before that read moved onto the narrower word have to add it. This is documented rather than newly true: #735/#736 made the machine read ask for `machines:read` instead of `machines:run`, and a plugin door's native bridge is the caller's capabilities intersected with the door's own `caps` plus `delegates`, which never widens either side — so declaring the read covers the plugin's half and not its caller's. An owner or root credential is unaffected, holding `*`. A token that is not gets `job_capability_absent:machines:read` from the hub, or `job_grant_unreachable:machines:read` where it holds the capability but no grant reaches that machine node, and a plugin that flattens native failures into one string shows its own word instead, the way `atyrode.omp` answers `omp_operation_unavailable`. `docs/CONTRACTS.md` and `docs/PLUGINS.md` now state the intersection as a rule for every delegate, because it is what makes the whole class predictable: a door declaring a capability never confers it on a caller who lacks it.
