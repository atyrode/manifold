---
section: Fixed
issue: 368
---

Terminal views preserve the shared character grid when returning through the index, keeping cursor-positioned applications coherent in smaller previews. Smaller viewports scroll the terminal rather than reflowing its live output; only the controller proposes a shared resize.
