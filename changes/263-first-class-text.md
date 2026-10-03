---
section: Breaking Changes
issue: 263
---

Text is now an independent collaborative document plugin with its own document browser, route and CodeMirror editor. Canvas notes borrow those documents through the nested Canvas notes plugin; removing a note does not delete its text, and documents remain editable when Canvas is disabled. The canvas Text tool belongs to Canvas notes, which requires both Canvas and Text. This ownership transition uses protocol 57 and an attended schema-52 migration: existing note bodies, references, original homes, attribution and valid retained revisions are preserved, with a complete pre-migration database backup for rollback. Upgrade compatible clients together and retain that backup until the migrated documents have been verified.
Preview seed projection preserves migrated document capacity without retaining token-revision metadata recreated by SQLite triggers.
Canvas selection survives text and geometry updates, keeping note resize handles usable while collaborative content changes.
Text's mounted document authority and lifetime preserve independent desired terminal viewports, transient sizing attribution and disclosure occupancy on the integrated viewport base.
