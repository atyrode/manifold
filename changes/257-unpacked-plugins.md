---
section: Added
issue: 257
---

Unpacked plugins: a directory under `<data>/authored/<id>/` the hub watches and rebuilds with the kit's own bundler, installed through the one install path as `install.mode: "unpacked"` and published without a reload — its panels remount in every joined browser on each save. Root turns the loop on with `engine.plugins.setDeveloperMode { on }` (published as `developerMode` beside the roster; off, every unpacked row refuses enable as `developer_mode_off`) and writes a plugin in one call with `engine.plugins.author { id, files }`. The plugin manager gains an Unpacked band with the developer-mode switch and marks each such row.
