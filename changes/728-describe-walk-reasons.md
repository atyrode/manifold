---
section: Fixed
issue: 728
---

Asking what a machine can run now says which authority check refused: a revoked credential, a plugin handle asking about another plugin, a missing capability and a grant that does not reach that machine are four different answers with four different remedies, where they used to be one word. A caller with no authority over the machine still learns nothing about it, including whether the identifier names one at all.
