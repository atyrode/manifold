---
section: Changed
issue: 1079
---

The sidebar's three creation rows are now one "+ New" split button. Its face repeats the last thing you made from this device ("+ New canvas", "+ New composition", "+ New folder"), and its ▾ opens a keyboard-accessible menu listing everything you can create, in order; choosing an entry makes it and makes it the face. On the collapsed rail the control is a single "+" that opens the menu. New folder now creates "Untitled folder" in one press and opens it for renaming in the Index. The existing New canvas, New composition and New folder settings keep their values and now show or hide that menu entry, and a disabled plugin's entries disappear. Any plugin, including a hardened one, can add an entry by declaring `contributes.creators` in its manifest: a title, a mark from a closed icon set, an order, the action to run with a fixed input, and an optional own setting. Plugin manifests carrying creators require protocol 58, and `core.index.createFolder` now also answers the created `folderId`.
