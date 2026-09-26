---
section: Fixed
issue: 840
---

Reviewing a deployment that re-enables a disabled native installation at the same revision no longer refuses with `services_unavailable` after the service it binds has become ready again. The hub used to keep the machine owner's last availability report from before the disable and ignore the owner's later reports while the installation stayed disabled, so the refusal lasted until the machine transport reconnected. Once the owner acknowledges a disable, hold or purge, the hub now drops that earlier report, and the review uses the service's current policy and provider installation. After the deployment re-enables the installation, the owner's new report decides availability. A provider that is still unavailable keeps the review refused, and so does an enabled installation whose own current report is unavailable.
