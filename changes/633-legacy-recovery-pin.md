---
section: Changed
issue: 633
---

An installation still serving v0.14.0 can now move onto the attested release path. Production promotion accepts that one release, pinned by its exact tag commit and immutable image digest, as the rollback base restored after a failed switch, and only while its tag still resolves to that commit with green full-main CI. Every other rollback release still needs full attestations, and a promotion candidate never uses this exception.
