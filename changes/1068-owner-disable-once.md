---
section: Fixed
issue: 1068
---

A machine whose native owner retains jobs of a disabled plugin no longer drops in and out of the hub in a loop that keeps its natives unavailable. The hub sent the plugin's disable to the owner again every time the owner proved itself, and the owner answers each disable by replaying the plugin's retained jobs. With enough retained jobs that replay overflowed the owner's connection to its transport, the transport reconnected, and the hub sent the disable again, about every half second. A crossing that holds natives for review, or an ordinary plugin disable, could start it. The hub now sends an unchanged disable once to each running owner, and again only after that owner or the hub restarts. Only the hub changes: deployed transports and owners need no upgrade or restart.
