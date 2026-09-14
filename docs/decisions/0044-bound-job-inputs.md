# ADR 0044: A job input bound to another job's sealed output

Date: 2026-09-14
Status: accepted
Ratified: 2026-09-14, by the operator ("A job input bound to another job's sealed output"; the primitive, its `/inputs/<name>` mount and its export consent)

## Context

Outputs only ever went one way. A job declares an output name, the owner mints a lease under an
admitted writable location, and at settle it seals that tree into a canonical POSIX ustar archive
with a SHA256 the hub retains (`packages/agent/src/job-outputs.ts`, `seal`). From there the bytes
leave the machine exactly one way: `ctx.jobs.output` / `ctx.jobs.outputs`, 64 KiB at a time,
through the hub, under the reader's own authority (`packages/server/src/job-service.ts`, `output`
and `outputs`). Nothing on the machine that holds a sealed archive ever consumed one.

That is fine for a receipt and useless for a corpus. The architecture ADR 0041 ratified —
`atyrode.babel -> atyrode.code -> atyrode.omp` — has Babel's `prepare` job assemble the material a
review needs, and Code's `runSession` post omp's one-shot session that must READ that material. The
model needs a filesystem to search: `find`, `grep`, open a file, follow a reference. What existed
instead was a job's declared inputs, and they are `inputFiles`: at most 65536 bytes of reviewed
literals and request strings, materialised as sealed anonymous memfds at `/inputs/<name>`
(`packages/agent/src/job-inputs.ts`). A corpus does not fit in a request string, and a plugin that
paged one out through the hub would have nowhere to put it on the way back in — a job request cannot
carry bytes, and the consumer plugin has no writable location on the producer's machine.

So data did not flow between plugins' jobs at all. Every composition either collapsed into one
plugin or went around Manifold. The operator decided on 2026-09-14 which shape closes it: **a job's
declared input bound to a sealed output of an earlier job on the same machine**, mounted read-only.

It is worth naming what the hole actually was, because the mount is the easy half. A sealed archive
already has an owner, a producing operation, an installation revision, an artifact digest and a
consent row — a whole authority story. `ctx.jobs.output` discharges all of it and then adds one more
condition: `callerOwnsNode`, the caller-plugin pin, which requires the reading plugin to BE the
plugin whose installation owns that job node (`job-service.ts`, `callerOwnsNode` and
`authorizedJob`). The pin is right for a door — a plugin has no business reading another plugin's
job by guessing an id — and it is exactly what makes cross-plugin flow impossible. The question this
record answers is not "how do we mount a directory". It is: **what does the producing plugin say
that replaces the pin?**

## Decision

### 1. The outputs primitive, inverted

An operation may declare `inputs`: at most sixteen names it reads, each mounted read-only at
`/inputs/<name>` as the extracted contents of one sealed output of one earlier job on the SAME
machine. A request binds them:

```
inputs: [{ name: "material", from: { jobId: "<producer job>", output: "material" } }]
```

`name` is the consumer operation's own declared input; `from.output` is the producer's output name.
They are independent, because the consumer's mount point is the consumer's vocabulary. `PublicJob`
echoes the admitted bindings, so a reader sees what a job was handed and not only what it produced.

It reuses the archive that already exists, verbatim: the same ustar the sealing writer produces,
read out of the owner's own private output store, digest recomputed on the way out. There is no new
format, no second copy, no wire transfer. The bytes never leave the machine they were sealed on,
which is also why the source must be on the same machine — a cross-machine binding would be a
transfer, and a transfer is a different primitive with different consent.

### 2. `exports` is what replaces the caller-plugin pin

The producing operation declares `exports`: which of its own `outputs` another plugin's job may
bind. It is a property of the operation, so it lives in the reviewed machine half beside `outputs`,
is shown to the operator with the rest of the declaration at deployment review, and is pinned by the
artifact digest every consent row names. An operation that begins exporting an output therefore
needs a new review, and cannot start exporting one behind an installed consent. A job of the SAME
plugin needs no export: an export names what leaves a plugin, and a plugin feeding its own jobs
crosses nothing.

This is the whole answer to the authority question, and it is deliberately the narrowest one. The
export replaces the PIN and nothing else. The requesting principal still has to hold `jobs:read` at
the source job's own node, through the same walk `ctx.jobs.output` takes — the capability, the grant
that reaches that exact node, and the consent row of the installation that job ran under. Revoking
that consent stops new bindings and refuses a deferred start. The producing plugin says "this output
may be read by others"; the reader's own authority still says "by you".

### 3. Four questions, in order, at the door and again at the start

```
unknown_input             the name is not one this operation declared it reads
input_source_unavailable  no such job here, or not settled, or it sealed no such output
input_not_exported        the source operation exports it to nobody, and is another plugin
input_authority_refused   the principal holds no jobs:read at the source job's node
duplicate_input           two bindings claim one /inputs name
```

That is the closed set; each refusal names the binding after a colon
(`input_not_exported:material`), so the codes stay a vocabulary while a caller with sixteen bindings
still learns which one failed. The order is declaration, then existence, then export, then
authority, and it is a deliberate trade rather than a privacy ladder: it is the order in which the
answers become CHEAP and WELL-FORMED. The declaration check reads the manifest already in hand.
Existence is what produces the source job's operation id, and the authority walk needs that id to
name a node at all, so authority cannot be asked first without inventing the node it would ask
about. Being honest about the consequence: steps 2 and 3 are an existence and export oracle for a
caller who already holds `machines:run` on the consuming operation and is guessing job ids — it
learns that a job exists and what it exported before its own read authority is graded. That is
accepted because the oracle is bounded to one machine's own jobs and to names the caller's
operation already declared, and because the alternative is a refusal that cannot say which binding
failed. If that ever stops being acceptable, the fix is to collapse 2-4 into one
`input_source_unavailable` for a caller without `jobs:read` anywhere on that machine, not to
reorder them.

A deferred start asks all of them again. A schedule occurrence or a queued job admitted while the
machine was offline can launch minutes later, by which time the source output may have been released
or the consent revoked; the start refuses rather than feeding it.

### 4. The owner extracts before spawn, or refuses by name

Before the sandbox exists, the owner writes each archive out into a fresh 0700 owner-only directory
under the `runtime` anchor's protected `job-inputs` root, and binds that directory read-only at
`/inputs/<name>` beside the outputs mounts. `limits.inputBytes` bounds the total, defaulting to the
consuming operation's own `outputBytes` — what an operation may produce is the natural measure of
what it may be handed — and may be lowered by a request but never dropped, like an inference
ceiling. The archive's own length is charged, checked before a byte is written, and summed across the
job's bindings.

Everything that can go wrong has a name and happens before spawn: `input_source_missing`,
`input_too_large`, `input_source_corrupt` (malformed, or a digest that no longer matches what was
sealed), `input_storage_exhausted`, `input_storage_unavailable` for a machine with no `runtime`
anchor. A binding that fails halfway leaves no directory and no descriptor, so "never a
half-mounted job" is true one binding at a time and not only in aggregate.

An extraction is DERIVED state. The sealed archive is the record; the tree is a convenience that
exists for one job's lifetime. It is removed when the job settles, is interrupted, or refuses to
start, and the owner deletes every extraction it finds at startup, because a tree that outlived its
owner generation belongs to a job that will never run again.

### 5. What the journal says, and what it does not

The bindings ride the job's `started` facts — they are request content, so the durable reservation,
the retained request, `PublicJob.inputs` and the lifecycle trace all carry them already. There is no
new event kind, because nothing new HAPPENS: an extraction is preparation, like resolving a location
or materialising an input file, and preparation that fails is a refusal with a reason, which the
journal has always recorded.

A nested invocation binds no input. An invocation edge consents to exact resources, exact output
rules, depth and aggregate limits; it says nothing about another job's archive, and inferring one
would let a parent hand its child an authority the operator never reviewed.

## Refused alternatives

**Page it through the hub and back in.** The reader already can: `ctx.jobs.outputs` in a loop. There
is nowhere to put the result. A job request carries no bytes, and a consumer plugin has no writable
location on the producer's machine — which is the same authority problem, now with a megabyte of
base64 through the hub for every review.

**Let the consumer declare a read location over the producer's output directory.** This is what a
plugin would try today, and it is wrong in the way that matters: named output storage is a bounded
tmpfs the producing job wrote into, whose path is an owner implementation detail, whose contents were
never sealed, and whose consent is `locations:read` on a location the CONSUMER declared. It would
hand a plugin the producer's live scratch space instead of the immutable thing the producer chose to
publish. Sealing is the boundary; an input binds a sealed archive or nothing.

**A new capability, `outputs:export`.** Tempting, because `locations:<access>` works that way. But a
location is a governed node with its own identity and revision, and an export is not: it is a
property of an operation, like `outputs` and `network`, and the operation's declaration is already
reviewed and artifact-pinned. Adding a cap would mean a second place the same fact lives, two ways
to say it, and a consent row that can disagree with the manifest. The declaration IS the consent,
because changing it changes the artifact.

**Drop the pin for job reads generally, and let `jobs:read` alone decide.** This would make the
whole feature unnecessary and is the one change that cannot be taken back. The pin is what stops a
plugin from reading another plugin's jobs by guessing ids; the grant system alone would let any
holder of a broad `jobs:read` walk the fleet. The export declaration is the narrow, per-output,
review-gated hole in the pin — not its removal.

**Bind a RUNNING job's output.** Process exit is not closure proof and only publication seals bytes
(ADR 0033). A running job's output directory has no digest, no length and no guarantee it will ever
have one. `input_source_unavailable` covers the unsettled source for the same reason `job_unfinished`
covers the unfinished read.

**Extract into the owner's state directory.** It is durable, unbounded and protected — three
properties an extraction should not have. The `runtime` anchor is a bounded tmpfs the kernel
enforces and a reboot clears, which is what derived per-job bytes want. The cost is that it shares
one finite backing with named outputs, and that is an explicit sizing instruction in
`docs/SELF-HOST.md`, not a hidden coupling.

## Consequences

- Babel's `prepare` can seal the material a review needs and Code's `runSession` can post a job that
  reads it at `/inputs/material/`, with the operator consenting to the export once, at review.
- The `/inputs` namespace now holds two kinds of thing: sealed bytes at a leaf (`inputFiles`) and an
  extracted directory (`inputs`). The manifest refuses a name in both, and the sandbox preflight
  refuses overlapping mounts, so the ambiguity cannot reach a workload.
- The `runtime` anchor's tmpfs must be sized for outputs AND extractions. The module's 1 MiB default
  is now visibly too small for any operation that binds a corpus, which is an honest thing for a
  default to be.
- The owner wire gains fields that cross its strict parser — `inputs`/`exports` inside the whole
  `MachineHalf` of an `install` frame, and `inputs`/`limits.inputBytes` in a `start` frame — so
  `JOB_OWNER_PROTOCOL_VERSION` moves to 36 and 35 joins the bounded retirement set
  `{30, 31, 32, 33, 34, 35}`, exactly as `concurrentJobs` took 31 and metered inference took 32. A
  drained owner at 35 can still be challenged to finish and retire its retained work; it is never
  an execution owner for this hub.

## Evidence

- `packages/protocol/src/jobs.ts` — `MachineOperationSchema.inputs`/`.exports`,
  `JobInputBindingSchema`, `JobRequestSchema.inputs`, `PublicJobSchema.inputs`,
  `JobLimitsSchema.inputBytes`.
- `packages/server/src/job-service.ts` — `inputRefusal` (the four questions), `dischargesJobCap`
  (the read walk without the pin), `build` (admission and the ceiling), `start` (the deferred
  re-check), `publicJob` (the echo).
- `packages/agent/src/job-outputs.ts` — `parseHeader` and `extract`, the inverse of `header` and
  `seal`.
- `packages/agent/src/job-bound-inputs.ts` — the staging root, its purge at open and its removal.
- `packages/agent/src/job-linux.ts` — `boundInputs` on the spec, its preflight and its read-only
  bind.
- Tests: `packages/protocol/test/jobs.test.ts`, `packages/server/test/job-service.test.ts`
  (§"a job input bound to an earlier job's sealed output"), `packages/agent/test/job-outputs.test.ts`,
  `packages/agent/test/job-bound-inputs.test.ts`, `packages/agent/src/job-linux.test.ts`
  (including the `[real-linux]` mount case `verify:jobs` selects).

## Revisit when

- A composition needs a source job on ANOTHER machine. That is a transfer, not a mount: it needs its
  own consent for moving bytes between hosts, and this record deliberately does not cover it.
- An invocation edge needs to carry an input rule the operator reviews, the way it carries output
  rules today.
- Extraction cost stops being acceptable — the same archive bound by many jobs is extracted once per
  job. A shared read-only extraction keyed by the output's digest is the obvious next shape, and it
  needs a lifetime rule this record does not have.
