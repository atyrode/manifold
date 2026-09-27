---
section: Fixed
issue: 827
---

Changing a machine's service configuration, including the instance-service update a native deployment review applies, now stops only the calls in flight to the services whose policy it changed or removed. A call admitted under a policy the new configuration keeps byte-for-byte, such as a model stream another session is making through an unrelated service, finishes under the policy it was admitted with instead of being cancelled along with every other service call, proxied request, tunnel and instance-service connection on the machine.
