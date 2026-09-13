---
section: Added
issue: 559
---

Autonomous work now enters Manifold as a sponsor-bound agent run instead of a generic identity: the run records its real authorizer, purpose, optional task reference, target, capability and time ceilings, policy revision, renewal budget and cleanup outcome. A new run receives no ordinary action authority until it fetches and exactly acknowledges the server-selected built-in and optional operator policy bundle; policy changes suspend active runs until exact re-acknowledgement. Agents may create bounded child runs with `agents:delegate`, but each child remains inside every sponsor credential's live permission waterfall at the actual action target, and finishing, revoking or expiring a parent withdraws its complete subtree. Generic human admission can no longer create or reissue agent identities, while machine, service and terminal-internal lifecycles remain distinct.
