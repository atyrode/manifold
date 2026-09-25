---
section: Fixed
issue: 848
---

A busy machine's job owner no longer refuses every job with `journal_capacity` once its journal reaches 128 MiB or 100,000 records, and it no longer fails to restart with a full journal. The journal is now written in segments: a full segment is sealed by a checkpoint signed with the owner's identity, which continues the hash chain and keeps every job's permit, identity, latest result and input cursor, and the sealed records move unchanged into `journal/archive/`. Startup reads only the checkpoint and one segment. An owner upgraded with a full journal converts it once at its first start, logging `journal_segment_sealed`; an older owner then refuses that journal instead of starting without its history. `manifold-agent --maintenance verify-journal --journal <directory>` rereads a journal and its archive and checks every checkpoint against the records it seals. `docs/SELF-HOST.md` documents journal sizing and retention.
