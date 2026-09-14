---
section: Added
issue: 583
---

Terminals now remember their working directory on Linux and can restart in place from the titlebar or `core.terminals.restart`, keeping their id, name, home and tile. Failed or unknown exits and owner replacement leave restartable tiles; clean exits and Dismiss still remove them. Directory fallbacks are reported, and older tiles without a launch recipe can be restored as a plain shell on an unconfined owner (governed owners refuse). The titlebar and terminal index show the recorded directory; older owners and Darwin report unknown. Running terminals require confirmation, and existing controller and maintenance safeguards still apply.
