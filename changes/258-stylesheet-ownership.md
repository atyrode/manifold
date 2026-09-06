---
section: Added
issue: 258
---

An installed or unpacked plugin can now ship its own stylesheet: a `styles.css` beside the manifest, declared with `"entry": { "styles": true }`, is carried in the bundle, served at `GET /api/plugins/<id>/styles.css` and injected into every joined browser while the plugin is enabled — removed the moment it is switched off. The hub admits a sheet only when every selector is rooted at the plugin's own class, `.plugin-<id with "." as "_">`, and refuses one that reaches past it by name (`stylesheet_unscoped`, naming the selector and its line) at install, at authoring and on enable, so no plugin can restyle the shell or another plugin from its sheet.
