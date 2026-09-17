---
section: Fixed
issue: 715
---

A native deployment is no longer refused over a resource only the operations it never selected require, so installing the operations a machine can actually run no longer needs a hand-picked sequence; a plugin that provides the service its own operations bind now says `service_provider_uninstalled` instead of reporting a provider installation that changed when it has never existed; `describe` names a declared plugin's operations before it has an installation, so a deployment request can be built from the hub rather than from the bundle; and cancelling an enabled instance service's workload cycles it instead of pinning `cancelled` to its revision, where it used to shadow every later deployment review of every plugin bound to that service.
