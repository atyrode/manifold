---
section: Fixed
issue: 416
---

Server and agent JSONL logs now use the same recursive field-name redaction policy, consistently removing nested credential and terminal-content fields while retaining useful diagnostic IDs, codes and counts. This structural safeguard does not scan arbitrary free-form strings for embedded secrets.
