---
section: Added
issue: 259
---

Portable plugins can now use the same React components in the page or in a hardened Worker, with hooks, context, keyed state, effects and accessible controls rendered through Manifold’s bounded component vocabulary. The Machines plugin runs with the same inventory, administration and terminal-creation behavior in either mode; self-hosted hubs can select its isolated server and Worker with `MANIFOLD_HARDENED_PLUGINS=core.machines`, including packaged Nix installations. Unsupported selections fail explicitly rather than silently changing execution mode.
