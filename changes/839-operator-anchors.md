---
section: Added
issue: 839
---

A machine's operator can now let reviewed plugin locations read a chosen host directory outside Manifold's storage, such as an agent's session tree, through an operator anchor named `operator.<name>`: it is read-only by construction, a location may name it whole with `components: []`, deployment review and Native Plugins show the exact host path it presents, and its pin changes whenever that path does. The native NixOS module declares them as `services.manifold.execution.operatorAnchors.<name>.path` and presents each directory to the owner as a root-made read-only idmapped view without changing the directory's owner, mode or ACLs; a view may lie beneath a protected directory but never contain one. Operator anchors need native owner RPC 40, and an older owner refuses only the operations that read one.
