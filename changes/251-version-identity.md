---
section: Added
issue: 251
---
Every build now knows what it is: `/healthz` answers `version`, `build` (`0.6.2` at a release, `0.6.2+21.gb7a07fe` past one) and `channel` (`release` or `development`), the sidebar's rev line prints the same `build`, and a development build says `development` in the sidebar and in the tab title — so a browser and the instance it looks at can be compared by eye, and two instances never look alike.
