---
section: Fixed
issue: 710
---

A plugin can now invoke the child job its own manifest declares: an approved, revision-pinned invocation edge is the authority for the hop, rather than a capability a job credential is never minted with. Previously only a wildcard-holding principal could traverse a declared and consented edge, so every sandboxed session that needed a co-located service silently lost it.
