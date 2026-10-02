---
section: Fixed
issue: 970
---

Database upgrades now stop and roll back the current schema version when a migration statement fails, instead of potentially committing partial changes and advancing the version marker. Historical SQL and code migrations execute complete prepared statements individually, preserving trigger bodies, migration order and pre-upgrade recovery backups.
