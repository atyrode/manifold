---
section: Fixed
issue: 936
---

Terminals now show ordinary screenshot previews, including OMP's landscape and photo previews at normal terminal widths and images wider or taller than the former cell limit. A refused image names the limit it exceeded, such as its size, pixel count, input bytes or terminal image cache, and a repeated refusal is reported once rather than on every redraw. Impossible images are refused before the browser draws them, so a burst of large images no longer freezes typing or scrolling. Late, reconnected and simultaneous viewers keep showing the same images and text. Terminals on a terminal host from before this change keep their earlier limits until the host is replaced through normal maintenance.
