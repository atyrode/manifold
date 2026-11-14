---
section: Added
issue: 1094
---

A managed native runtime alias can now include explicitly selected, independently hash-verified file groups from pinned artifacts. The executable and complete read-only directories share the existing alias, consent and mount budgets, so offline runtime assets do not require another alias or undeclared downloads. Groups require machine protocol 60, native owner capability 46 and hardened contract 14; older accepted owners keep compatible operations but refuse grouped ones rather than dropping files. Publishing this support does not activate or restart an owner. Trusted source proofs can supply owned prepared archives through the real host-library startup and acquisition paths without changing declarations or the ordinary HTTPS path; prepared-byte proof is distinct from verification of the published artifacts.
