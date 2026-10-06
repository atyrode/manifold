---
section: Fixed
issue: 1050
---

Native installations, instance services and Code postings now come back after the machine transport reconnects to the hub, without restarting the transport. After an owner restart under a running transport, or a hub liveness timeout, the native owner could sign an identity that had moved since the transport named it, and the hub silently refused that proof. The transport now recognizes such a proof, logs `job_owner_unproved` with the identity fields that changed, and reconnects naming the owner's current identity. Only the transport implementation changes, and the running owner can remain untouched. The installed transport release must still be one the deployed hub accepts: upgrade the hub first if it does not accept the transport's protocol version, since otherwise every hello is refused with 4409.
