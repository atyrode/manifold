---
section: Fixed
issue: 494
---

Instance services retired during launch now keep their worker context available for the first valid workload request to receive its applicable response, including `service_closed` for service readiness, then drain pending replies before closing instead of abruptly breaking the context channel.
