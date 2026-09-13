---
section: Added
issue: 516
---

A panel tile can now be opened for a particular thing. A panel leaf carries an opaque argument of its plugin's own naming — bounded, stored with the arrangement, and kept across reloads and rearrangements — which the panel reads as an ordinary prop, so two tiles of one panel can show two different records instead of both following one shared selection. A panel opens more of its own panels with `host.openPanel`, which places the new tile beside the one that asked, through the same workspace-layout door a drag release uses; asking again for something a tile already shows focuses that tile rather than opening a duplicate.
