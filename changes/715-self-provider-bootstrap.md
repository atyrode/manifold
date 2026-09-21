---
section: Added
issue: 715
---

Reviewed native deployments can bootstrap a plugin's job-scoped service provider and consumers together by omitting `runtime.installationRevision`. The runtime binds to the exact invoking installation, never the latest one, while retaining artifact and provider-resource pins. Review requires selected or already-authorized provider rights; apply commits the installation, invocation edges and selected consents together, and execution waits for real native readiness. Unsupported transports and owners refuse this mode without disabling unrelated explicitly pinned services.
