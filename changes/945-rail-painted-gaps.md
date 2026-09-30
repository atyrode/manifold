---
section: Fixed
issue: 945
---

Dropping a stack into a sidebar gap now places it between the rows that actually border that gap, even when spare room or hidden rows makes the projected layout differ from its painted extent. Nested row and column gaps keep their direction and retained rows; real drag, fill and reorder checks continue to exercise the unchanged release path.
