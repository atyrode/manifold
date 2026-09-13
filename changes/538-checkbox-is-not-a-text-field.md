---
section: Fixed
issue: 538
---

The plugin manager's machine operations card is readable: a plugin declaring a machine half showed each machine's name and evidence one character per line, because the floor's text-field default sized every input at the row's full width, checkboxes included, and the card's prose sat at the root's 16px beside the sheet's 0.78rem text. The default now applies to text-like inputs only, at the same specificity, so the install dialog's _Run hardened_ and the developer-mode switch take the browser's own size too, and the door form's workaround for the same rule is gone.
