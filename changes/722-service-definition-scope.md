---
section: Fixed
issue: 722
---

A native deployment is no longer refused `service_definition_changed` over a service that only the operations it never selected bind, so deploying an operation that declares no services at all no longer waits on another operation's service policy being re-pinned. The service definition every selected operation binds is still checked at review, at application and again before the operation runs.
