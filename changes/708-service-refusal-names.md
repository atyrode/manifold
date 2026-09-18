---
section: Fixed
issue: 708
---

A service call a machine owner will not serve now says which fact refused it, and the refusal reaches a reader. One `503 service_unavailable` answered at nine sites — four in the workload proxy and five entry branches in the owner, plus the tunnel and remote paths beneath them — and neither side recorded anything, so a workload that could not reach a service it was entitled to and the operator watching that machine saw the same undifferentiated fact. Each site now names its own fact, the owner logs it as `service_call_refused`, and the hub records it as `service_refused` in the same service trace as the authorization it followed, so a service the hub reports `ready` that refuses every call reads as the contradiction it is instead of requiring the owner to be instrumented. A sandboxed workload still learns only the fate of its own call: refusals that name the owner's topology project to `service_unavailable` at that boundary, because a caller able to read them could enumerate the machine it runs on by making calls. Cancellation is no longer reported as unavailability either, which had made any measurement taken at the proxy wrong in the same way.
