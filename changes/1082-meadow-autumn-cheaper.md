---
section: Changed
issue: 1082
---

The landing concept lab's Meadow and Autumn scenes now do less work per pixel for exactly the same picture: the meadow's framing grass works out a blade's colour, a stalk's details and a seed head only where they can show, and the autumn canopy looks at its holes only where the canopy reaches and works out its ragged underside once per leaf instead of twice. Shapes drawn from a zero-length line, such as the drop swelling on a dripping leaf tip in Bamboo and Forest, no longer rely on arithmetic the graphics driver may leave undefined.
