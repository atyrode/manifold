---
section: Added
issue: 503
---

Native plugin installation gains typed headless review and approval for explicit machine destinations through the same authority path as the runtime inspector. Operators can review exact declarations, artifacts, resource pins and operation consent separately from installation, retain approval for known offline destinations, inspect progress and cancel unapplied work. Changed evidence or uncertain application requires another review; reconnect never restores revoked consent, and readiness requires the native owner's installed acknowledgement. Plugins receive a capability-checked read of their own destination's progress and actual installed declaration without acquiring installation or consent administration.
Selected native service consumers now review their exact caller/callee invocation edges as part of the same first-install approval. The review displays existing versus new edge revisions, bounded depth, concurrency and aggregate ceilings, exact callee location access and output mappings. Apply commits the installation, reviewed edges and consent atomically; changed callee policy, resources, permissions or prior edge authority requires a new review, and install-only or deselected operations grant no edges.
The reusable plugin workflow accepts an optional preparation command before checks and tests, allowing consumers to verify a pinned dependency tree and declare disposable native-runtime fixtures without publishing those fixture artifacts.
