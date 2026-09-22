---
section: Changed
issue: 633
---

Production promotion now confirms that the verified rollback image still resolves in its registry before switching, so a deleted recovery image stops the promotion while the incumbent is still serving instead of surfacing only after a failed switch.
