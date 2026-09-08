---
section: Changed
issue: 423
---

Browser terminals render inline Sixel and iTerm images with shared, reconnectable image state, advertise truecolor to terminal applications, and close across all viewers when their root process exits instead of retaining an exited tile. Trackpad panning and pinch zoom cross inactive terminals without losing normal scrollback after engagement. Image clipboard paste continues to use the application's native protocol, including after reattachment to an up-to-date terminal host.
