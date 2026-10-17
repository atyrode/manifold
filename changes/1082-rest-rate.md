---
section: Changed
issue: 1082
---

In the landing concept lab, a scene that moves now keeps drawing at the full rate, about 60 frames a second, while nothing is touched; it used to drop to about 30 after a few seconds at rest. The Motion group has a new "At rest" choice, "Full rate" or "Half rate (saves battery)", kept in the link as `rest=half`, for the old behaviour.
