---
section: Changed
issue: 1082
---

The landing concept lab builds off the page's thread: the countryside's terrain and land, frost's crystal field, the dew web respun for a new window shape and the slime mould's fresh dish now run on one build worker (it replaces the pond's sheet worker and paints its sheets too), handing their arrays back by transfer, so a knob change no longer stalls the page for most of a second while the previous picture stays up; a newer change drops a build still running. A land-use change no longer repacks or uploads the whole map, only the parcels it moves, and sends the parcel map only where a wood's pine flag changed (a change of the herds alone sends none of it), and the dew web waits for a dragged window edge to rest before respinning, as the garden does. Every build is byte for byte the one the page made before, and runs on the page as before where no worker can start.
