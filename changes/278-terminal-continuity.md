---
section: Breaking Changes
issue: 278
---

Machine agents now use a separately supervised terminal host so transport updates, crashes and rejected duplicates leave running terminals intact. Machines can be drained for maintenance without ending existing work. Existing combined agents must finish their terminals before migrating.
