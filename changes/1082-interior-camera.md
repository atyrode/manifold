---
section: Added
issue: 1082
---

The landing concept's rooms have a camera that moves. A `cam=` link key holds a pose about the room's rest view (moved across, up and in, turned, tilted and zoomed), and the lab's Camera section moves it axis by axis, shading how far each axis may go. The room's wall, window and ledge are redrawn from the moved eye, the lava lamp and the solar-system mobile follow it, and the city through the sill's window turns with the view; things painted on the frame (the cat, the props, the curtain, the bonsai, the incense, the bar and the train) move only a little with it, as with the pointer, and hold the camera near rest while they are on. A layer switched on where the camera stands outside what it can draw is refused with the reason. A link without `cam=` draws exactly as before.
