---
section: Fixed
issue: 518
---

Shared resource readers keep requests and accepted values bound to their subscribed resource when another reader changes destinations. Joining the same feed still shares its initial request, while a new live event binding catches up after an older pending snapshot settles so a quiet connection cannot leave readers permanently stale. Drafts and replacement generations remain isolated across destination changes.
