---
section: Added
issue: 444
---

Plugins can atomically compare and replace their own stored values with `storage.compareAndSet`, preventing concurrent actions from silently overwriting each other's choices. The same promise-returning operation is available to in-realm and hardened plugins, with the existing namespace, reserved-key and UTF-8 size protections and no automatic product events.
