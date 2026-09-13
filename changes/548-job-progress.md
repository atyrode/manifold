---
section: Added
issue: 548
---

A running machine job can now say where it is. A workload writes `{"stage": "at the model"}` — optionally with a `message` and a `fraction` — to the private owner channel it already has on `MANIFOLD_JOB_CONTEXT_FD`, or calls `reportProgress` from the worker SDK; its owner folds those lines to at most one `job_progress` event every five seconds per job with the newest one winning, stamps the time it observed the line, and flushes whatever it still holds before the job's terminal event. Followers see the stage live and the job's journal keeps it after the job settles, so the long gap between `started` and a first model call is no longer indistinguishable from a job that is never going to reach one. The hub admits a stage only for a job it has already seen start; a stage is the workload's own word and nothing waits on one, so a job that reports none is unchanged.
