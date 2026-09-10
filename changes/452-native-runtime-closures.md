---
section: Added
issue: 452
---

Native NixOS execution profiles can explicitly select the complete immutable closures of their runtime tools, including interpreters, helpers and libraries, without exposing the host PATH or whole Nix store. Read-only runtime files support Nix hard links while private configuration and credentials retain their stricter identity checks. Polling work queued behind installation no longer interrupts its later admitted start.
