---
section: Fixed
issue: 573
---

Pi-native inference now counts cache-write tokens in physical input totals and prices them at the existing fresh-input rate, so subsequent calls cannot evade input or cost ceilings by omitting those tokens. Cached-read attribution and OpenAI accounting are unchanged. Cache-write pricing remains a conservative floor rather than provider-invoice equivalence.
