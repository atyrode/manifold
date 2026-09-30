---
section: Added
issue: 953
---

External plugin authors can opt into React Fast Refresh with `manifold-dev <plugins-root> --fast-refresh --hub <origin>`. The development frontend updates compatible components and scoped CSS without losing unsaved React state, while installed-plugin admission stays authoritative. Stopping or losing the source session restores the admitted packed plugin; ordinary pack, verify and install remain unchanged. `--help` and `--describe` expose the prerequisites and session lifecycle without credentials.
