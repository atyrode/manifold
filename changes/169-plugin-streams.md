---
section: Added
issue: 169
---

Plugins can publish schema-bounded continuous streams on the existing session socket, with public job/stream context types, declared ownership, delivery-time authorization, ordered sequence numbers and bounded reconnect replay. Slow readers and expired watermarks receive explicit gap/reset or closure signals instead of an invented continuous history; stream bodies never become event-plane rows. Producer close listeners let plugins release job-follow handles on disable or teardown, while private job bytes remain separate from deliberately published metadata.
