---
section: Changed
issue: 1082
---

The landing concept's frames now come evenly on any display: the page draws on every n-th refresh, nearest 60 frames a second (75 on a 75 Hz screen, 45 at 90 Hz, 72 at 144 Hz, 55 at 165 Hz), from a refresh rate it measures through jitter and dropped frames, instead of alternating short and long frames. While nothing is touched and no passage or "now" event plays, it rests at about half that, 30 frames a second on most screens, and any pointer, key or wheel input, in the lab too, brings the full rate back at once. The scene's committed thumbnail now shows from the first paint, for the scene the link names, and the scene dissolves in out of it once its shader is ready; it also stays up while a lost graphics context comes back. A stage up to a quarter past the cell budget keeps its cells, so one pixel row more than 1080p, or a windowed 1920 × 1200 browser, no longer halves them. Each scene's clocks now count from its own start, so long sessions keep the shimmer and motion as fine as at first; "keep the world" and an A/B flip carry the clocks over, so the hours, year and stars go on where they stood.
