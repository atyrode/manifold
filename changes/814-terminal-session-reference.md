---
section: Added
issue: 814
---

Governed terminals can retain an optional machine-bound harness session reference and expose it through existing authorized terminal inventories and live room state, so clients can reopen exact running matches without guessing from titles or working directories. The reference survives terminal lifecycle changes and server restarts, grants no additional authority, and remains absent for historical and ordinary terminals. Session protocol 42 requires updated SDK clients; existing machine and native-owner connections remain compatible.
