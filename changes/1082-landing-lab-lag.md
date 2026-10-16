---
section: Fixed
issue: 1082
---

The landing concept lab keeps the address bar on the setup during long slider drags: it writes it at most every 400 ms and always writes the last setup, where it wrote one per frame and Chromium silently ignored writes past 200 in ten seconds (Firefox and Safari throw instead, which stopped the change applying). A scene switch in the lab no longer waits for the previous scene's all-features program building ahead in the background, nor for one of a scene passed over, and the lab's controls rewrite only what changed while a slider moves.
