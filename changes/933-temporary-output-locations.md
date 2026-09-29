---
section: Added
issue: 933
---

Native job locations can now be declared `temporary: true`, so raw output scratch no longer fills a machine's runtime storage after its jobs finish. A temporary location is a `runtime` directory used only as write-only output backing: each job writes into its own private root, and the owner discards it once the job's processes are proven gone and its result is published, including after failed collection, nonzero exits, cancellations and refused starts. Sealed outputs are kept, read and bound exactly as before, and existing locations keep their retained lifetime. Nested invocations cannot write a temporary location and are refused `temporary_output_invocation_unsupported` before starting. If cleanup fails, the result stands, the owner logs `job_output_cleanup_failed` and stops admitting new jobs. Temporary locations require an owner at native RPC 43; older owners never receive them and refuse only the operations that use them.
