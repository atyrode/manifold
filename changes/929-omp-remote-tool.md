---
section: Added
issue: 929
---

The installed terminal client now exports an optional filesystem-native OMP `manifold_ssh` tool for literal remote commands, separate stdout/stderr, UTF-8 stdin and private authoritative receipts. Ordinary nonzero remote exits, including 255, remain results; refusals and cancellation retain final cleanup evidence as tool errors. Registration uses a local secret-free binding probe, omits ineligible contexts and respects OMP restricted-session opt-in. Unknown/offline SSH targets can suggest only caller-visible online nonrevoked machine IDs and names, without claiming shell authority.
