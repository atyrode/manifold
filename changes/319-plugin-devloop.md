---
section: Added
issue: 319
---

Out-of-tree plugin authors get a development loop and a delivery path: the plugin kit gains `dev` (pack, install on a hub, watch and reinstall on change), `verify` (install packed bundles on a real spawned engine, knock on every door, uninstall) and `install` (idempotent install or replace of one bundle, delivered by path or into a container's drop box, the owner key read from a file or the container and never printed); a reusable GitHub workflow runs check, test, pack and verify for an author repository against the manifold revision it pins; and the preview receiver accepts `plugin <url> <sha256>` so a release of an author repository installs itself on the integrated preview.
