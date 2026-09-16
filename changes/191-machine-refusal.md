---
section: Added
issue: 191
---

Machine inventory reads now retain the latest identifiable rejected agent dial with its close code and hub timestamp. Repeated refusals replace the diagnostic, restarts and credential changes retain it, and a successful machine admission clears it, so operators and plugins can distinguish a currently rejected offline machine without reading the agent journal.
