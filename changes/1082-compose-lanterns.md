---
section: Changed
issue: 1082
---

The landing concept's lantern river is now a preset of the `outdoor` composer (ADR 0062 Phase 2a): three layers, the temple grounds behind (`temple`), the river with its two stones (`river`) and the floating lanterns (`lanterns`), each switched by a knob keyed by its id. The lanterns' light now falls on other layers as a composer light, and a backdrop may give its view in a level mirror, which the river mirrors. Its rain and birds are the World's: the drops through the lantern light and the geese differ a little in their light, and the river gains the World's other knobs (snow, fog, lightning, cloud and its shadows, the moon's phase, the Milky Way, the cumulus towers). Keys: the lantern count is the `lanterns` layer's switch (`lanterns-amount`), the M lantern `lanternsMark`, the evening's seed the composer's `seed`. Its default picture is the same but for three cells, where a lantern's soft edge in front of the near stone now shows the stone rather than the water behind it.
