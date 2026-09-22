---
section: Added
issue: 827
---

A native deployment review can now carry one instance-service bootstrap or update beside the installation that provides it, so a plugin whose own operation serves the service its other operations bind can be installed for the first time, or updated in place, through the existing root-only review and apply. Review resolves the concrete provider pin, its policy and its promoted binding, and shows the prior record and the exact provider workload the approval may stop; apply installs, waits for the owner's own acknowledgement, configures the reviewed policy and starts the provider, stopping nothing else on the machine. Ordinary deployment requests and instance-service configuration are unchanged.
