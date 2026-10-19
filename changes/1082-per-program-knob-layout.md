---
section: Changed
issue: 1082
---

Composed scenes in the landing concept lab now give each shader program only the knobs it reads: the composer's, those of the layers switched on, and any other its code names. Each program's knob uniform is sized to those knobs (four a row) and the renderer uploads the knob values through the program's slot map, so a scene preset can list up to 512 knobs, up from 64, and one program reads up to 128. Composing a preset past either limit fails with an error that names the cap and, for the per-program limit, the layers that pass it. No picture changes, and no program uses more uniform vectors than before; the busiest measured program drops from 205 to 202 of the 224 that WebGL 2 guarantees.
