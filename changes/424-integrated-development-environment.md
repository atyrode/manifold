---
section: Fixed
issue: 424
---

Integrated preview terminals now use the same pinned portable development environment as numbered previews, including OMP and Code. Deployment checks the complete image before replacing the running development hub, preserves its identity and canvas data, and explicitly retires the hub's existing terminals without restarting independent spoke terminal hosts or changing production.
