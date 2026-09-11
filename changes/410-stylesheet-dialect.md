---
section: Fixed
issue: 410
---

A plugin stylesheet that uses a CSS form the ownership rule cannot check is now refused by name instead of admitted by silence. What the hub reads is style rules, `@keyframes` names and the grouping at-rules `@media`, `@supports`, `@container` and `@layer`; `@scope`, `@import`, global-name forms such as `@font-face` and `@property`, any other at-rule, and a rule nested inside a rule are each named in the refusal with the line and the form as written. A foreign selector hidden inside `@scope` used to install cleanly, because a construct the walk skipped was a construct nothing had checked. This remains ink ownership and not isolation — an in-realm plugin holds the DOM and can still paint from code — and every selector a plugin could already write from its own root class is admitted exactly as before.
