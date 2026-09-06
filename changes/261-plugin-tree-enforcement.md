---
section: Changed
issue: 261
---

Plugin ids now stop at three segments: a child such as `publisher.product.part` must declare a required dependency on `publisher.product`, or assembly refuses it as `orphan_child`; four-segment ids are refused by the schema. The authoring gate enforces parent-to-child import isolation and permits a child to import only its parent's published contract.
