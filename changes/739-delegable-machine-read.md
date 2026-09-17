---
section: Fixed
issue: 739
---

A plugin door may now be lent `machines:read`, so it can ask whether the machine it was deployed to is ready without making every caller hold a machine capability to be told. The delegable set already admitted the authority to make a machine run something and excluded the authority to read what that machine is, which left reading a machine's own installation unreachable from any plugin door. A delegate is still a ceiling: the caller's own capabilities and the plugin's install grant both bound it, and the read's per-node consent still decides.
