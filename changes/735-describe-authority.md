---
section: Changed
issue: 735
---

Reading what a machine can run for a plugin now takes `machines:read` at that machine — the capability for reading a machine's own facts — together with that installation's own consent to run something there. It used to demand `machines:run`, which is governed and therefore excluded from every install grant by construction, so no plugin could reach the door whatever it declared, was granted or was consented, while its consents sat enabled at the right revision. An operator's own read is unchanged, including for a plugin with no installation yet.
