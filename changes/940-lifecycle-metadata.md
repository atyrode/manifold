---
section: Added
issue: 940
---

Plugin lifecycle hooks can inspect current installed/enabled plugin identity, live public machine inventory, and visible instance-service readiness and policy revisions through narrow read-only metadata handles. Ordinary callbacks use the original installer's live credential; settled-job callbacks use that job's authority instead. Reads enforce current manifest and install grants, service-resource visibility, revocation, expiry and hook lifetime without exposing machine effects, invocation, configuration or secrets. Hardened contract 11 announces the handles only to compatible guests, preserving older packed hooks unchanged.
