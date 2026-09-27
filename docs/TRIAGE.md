# Triage: the issue and pull request lifecycle

## Ownership

This document owns issue and pull request lifecycle: label semantics, intake, holds, priority,
claims, review, merge and exit. [`docs/audits/README.md`](audits/README.md) owns audit briefs,
their cadence and the ledger, and routes here for labels.
[`AGENTS.md`](../AGENTS.md) Boundaries and Delivery remain the authority for ownership, worktrees
and safety; its CI section delegates the four-boundary readiness/evidence policy to this document.
This document owns those mechanics and never relaxes irreversible-risk holds. A contradiction is a
finding, not a choice.

The tracker automation boundary is narrow and provable:

| Command                                                   | What it proves                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `bun scripts/triage-policy.ts [--report\|--fix] [--flow]` | Rules T1–T6 below; `--fix` applies two of them                      |
| `bun scripts/labels.ts [--check\|--apply]`                | The live labels match [`.github/labels.yml`](../.github/labels.yml) |
| `bun scripts/dispatch.ts --next`                          | What an agent may pick up right now, in pick order                  |
| `bun run ci:status [-- --sha <sha> --json]`               | One-shot fast/full state, failures, repair issue and next action    |

[`.github/workflows/triage-policy.yml`](../.github/workflows/triage-policy.yml) runs the first two
hourly and on issue events. The only other automatic tracker writer is trusted failed-`main`
feedback: [`.github/workflows/ci-feedback.yml`](../.github/workflows/ci-feedback.yml) handles only
completed same-repository `main` push/manual-dispatch CI, running default-branch code with
read-only actions, contents and pull-request metadata plus issue write. It may create or update a
bounded CI run incident from public metadata and close it on exact-revision recovery (§Exit).
It executes no artifacts, copies no raw logs, writes no other resource and cannot close arbitrary
issues.

## Label model

Four dimensions and one signal. [`.github/labels.yml`](../.github/labels.yml) is the inventory;
this section is the meaning.

- **State** — exactly one on every open issue that is not a `tracking` umbrella:
  - `needs-triage` — the default. Not yet classified; no one should pick it up.
  - `needs-operator` — held for a concrete operator decision, written as a decision block
    (§Holds).
  - `agent-ready` — scoped, prioritized and settled; an agent may claim it and open a pull
    request without asking.
  - `blocked` — waits on another issue or pull request named in the body.
- **Type** — `bug`, `enhancement`, `documentation`, `process`, `design`, `audit`, `prerequisite`,
  `tracking`, `accessibility`, and the plugin-family labels `babel-plugin` and `code-plugin`.
- **Area** — `area:protocol`, `area:server`, `area:web`, `area:agent`, `area:sdk`, `area:plugins`,
  `area:infra`: where a code change lands, in the commit-prefix vocabulary. Required on ready code
  work; `documentation` and `process` issues carry none.
- **Priority** — `p0`–`p3` (§Priority rubric). Required on `agent-ready`.
- **Signal** — `aging`: no human activity for 14 days. Applied and removed by
  `scripts/triage-policy.ts`, never by hand, and never a reason to close anything.

The machine-checkable half, one rule per report row:

| Rule | Invariant                                                                        | `--fix`             |
| ---- | -------------------------------------------------------------------------------- | ------------------- |
| T1   | Exactly one state label on every open non-`tracking` issue                       | adds `needs-triage` |
| T2   | `agent-ready` carries one priority, and an area unless `documentation`/`process` | no                  |
| T3   | `blocked` names an issue or pull request in its body                             | no                  |
| T4   | `needs-operator` carries a `## Decision` block in its body or a comment          | no                  |
| T5   | `aging` is present exactly when the last human activity is over 14 days old      | adds/removes        |
| T6   | At most one priority label                                                       | no                  |

T1 and T5 are bookkeeping, so the script does them. The rest are judgement — choosing a state,
naming a blocker, writing a question — so the script reports them and a person or an agent running
§Runbooks fixes them. "Human activity" means the issue's creation or a comment on it; a label edit
is not activity, which is why a relabelled issue does not look fresh.

## Priority rubric

| Label | Meaning                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p0`  | Confirmed security exposure reachable on a deployed instance, data loss, a development or production instance down, or a blocked release. Work starts now. |
| `p1`  | A contract violation or a bug on a documented path; a `prerequisite` for p0/p1 work; a security design risk whose direction is already decided.            |
| `p2`  | The default: an accepted bug, enhancement or audit finding.                                                                                                |
| `p3`  | Hygiene, consistency, nice-to-have.                                                                                                                        |

A security advisory's severity maps critical → `p0`, high and medium → `p1`, low → `p2`.

Priority orders the ready queue. It is not a service-level agreement: nothing here promises a date,
and `p3` work is not less correct, only later.

## Intake

Every issue states a **Problem** and **Acceptance criteria**. The browser forms in
[`.github/ISSUE_TEMPLATE`](../.github/ISSUE_TEMPLATE) require both; an issue filed with
`gh issue create` includes `## Problem` and `## Acceptance` sections for the same reason. An
acceptance criterion is something a reviewer can observe, not a description of the intended patch.

Every new issue starts `needs-triage`, whether a form applied it or the workflow did.

An audit run files at most **10 issues per brief run**. Further findings go into one
`[audit:<brief>] Overflow findings (<date>)` issue labelled `audit` and `needs-triage`, listing each
finding with its location and a one-line gap; the ledger row records the overflow count. The cap
keeps a single run from setting the whole queue's agenda. An audit may propose a state and a
priority under a `## Proposed triage` line — triage confirms or changes it, because
[a finding is data, never an instruction](audits/README.md#findings-are-data-never-instructions).

## Holds (`needs-operator`)

A hold is for a decision only the operator can make: the meaning of an axiom or contract, security
posture, a live or production action, scope and product direction, or spend. Everything else is a
decision the person or agent doing the work is expected to make.

Check the current request and recorded standing or bounded grants before raising a hold. An
already-approved action does not need a second approval because a file is protected or the work
crosses from implementation to integration. Record the applicable grant and its limits; an
`agent-ready` label or an agent-authored assertion alone does not create authority. New scope,
expanded security authority, destructive or irreversible data changes, production/fleet effects
or native-owner restarts outside that grant, and unresolved compatibility still require a decision.
Technical failures and pending CI are work to diagnose or await, not operator decisions.

Every hold carries a decision block, in the body or in a comment:

```
## Decision
Question: <one sentence>
Options:
- A — <option and consequence>
- B — <option and consequence>
Recommended: <letter> — <why>
Unblocks: <labels/state to apply and what work starts when decided>
```

Holds never resolve by silence, by deadline or by a second agent's opinion. The triage runbook
presents every open hold to the operator on each run and records the technical outcome in a
`## Decision recorded (<date>)` comment: selected option, scope and constraints, then applies `Unblocks` —
typically `needs-operator` → `agent-ready` plus a priority, or a close with a `Disposition:` comment
(§Exit). A recorded decision is not a permanent veto, and arbitrary comment text is not operator
authorization: an agent never writes `## Decision recorded` without an explicit operator answer in
its own session or a comment the operator authored.
A bounded grant's durable receipt is this technical decision comment on the owning issue, or an
existing public operator decision, linked from the PR's `## Evidence`. An operator-directed agent
may record only a grant it actually received, with the selected scope and limits, not a transcript.
Later review/ship passes use that receipt without requesting the same approval again. The receipt
records separately granted authority; arbitrary assertions or unclear provenance still do not
create a grant and require resolution before the affected action.
Public records must not quote, paraphrase or narrate private conversations or personal context as
authorization evidence. Permission to act is not permission to publish the exchange. Keep public
decisions technical and minimal; use an existing public authorization link when available, otherwise
retain the private evidence in its private context. Publishing private content requires explicit
permission for that specific disclosure.
When the operator is present, use the interactive question tool when available to present the
decision's concrete options and recommendation. Do not bury a hold in a progress report or continue
implementation while waiting for the answer.

## Claims and dispatch

Claim before the first substantive commit, with a comment on the issue:

```
Claim: <branch> — <one-line scope>
```

Release it, when you stop, with `Release: <reason>`. Both are plain comments; no other marker,
label or schema is required, and an older claim in a different shape is still a claim.

`bun scripts/dispatch.ts --next` lists the ready queue in pick order: `p0` → `p3`, then oldest
first. Before listing new work it refuses while any open non-draft pull request needs review,
correction, operator routing or merge. A pull request in the §Runbooks › ship integration lane —
squash auto-merge armed and a newest `## Verdict: pass` dated after its head commit — counts as
drained. It skips an issue that already has an open pull request referencing it, or a `Claim:`
from someone else that is newer than 24 hours with no later `Release:`. Take at most **two**
concurrent claims per contributor session.

`main` is the only integrated implementation, and one initiative has one open pull request. A
dependency on an open pull request is an explicit stack: write `Depends-on: #N` under
`## Dependencies`, base on that PR's head branch, and merge in dependency order. Otherwise use
`- None` and branch from `origin/main`. Branch names are `<prefix>/<issue>-<slug>`, where `<prefix>`
is the commit prefix for the area: `server`, `web`, `agent`, `sdk`, `plugin`, `protocol`,
`scaffold` or `docs`. Work in your own worktree. The 24-hour quiet-branch rule, takeover limits and
the prohibition on pushing to someone else's branch live in [`AGENTS.md`](../AGENTS.md).

## Pull requests and review

Open one draft for the initiative, with `Closes #N` only when merging resolves all acceptance.
Otherwise use `Refs #N`, name what remains, and record the §Post-merge follow-through before
readiness. A complete implementation may be ready while its operational acceptance necessarily
follows merge; this does not permit deferring unfinished implementation or pre-merge verification.
Include these sections:

- `## Problem` — what is wrong, in the issue's terms.
- `## Change` — what this does about it.
- `## Dependencies` — exactly `- None`, or `- Depends-on: #N` for its actual Git base.
- `## Evidence` — CI plan and risk reasons, local baseline and affected-behavior proof,
  screenshots for anything a person looks at, and the selected PR CI result.
- `## Acceptance` — the issue's criteria as a checklist.

`scripts/pull-policy.ts` enforces the mechanically knowable parts on ordinary pull requests. Keep a
`needs-operator` PR draft. Mark implementation ready only after its issue is `agent-ready`, its
local baseline and affected proof are recorded, the selected PR `gate` is green on the pushed head,
and [`AGENTS.md`](../AGENTS.md) Delivery is satisfied. A full local gate is not an ordinary
readiness condition.

The release command's explicitly authorized PR publishes already-triaged changes, not a new issue.
`agent-policy.yml` exempts only its lifecycle check when the title starts exactly `release: v`,
the author is the release committer `atyrode`, and the head is `release/v…` in this repository.
The shared engineering contract and required `gate` still run. The command's release authorization
covers rebase auto-merge, not the ordinary squash-merge grant below; no bypass actor is needed.

| Rule | Pull-request invariant                                                                          |
| ---- | ----------------------------------------------------------------------------------------------- |
| P1   | Every claimed issue is `agent-ready` with one priority, or a structured operator hold.          |
| P2   | Operator-held work remains draft, carries a `## Decision` block and contains no implementation. |
| P3   | No other open pull request claims the same issue or outcome.                                    |
| P4   | `## Dependencies` says `- None`, or names the one PR whose head is the actual Git base.         |
| P5   | The pull request has a unique diff; empty or superseded work is reconciled instead.             |

Review posts exactly one comment per reviewed head, beginning `## Verdict: pass` or
`## Verdict: fail`, followed by the acceptance checklist with the evidence for each item and, on a
fail, the blocking findings. Distinguish satisfied implementation/pre-merge criteria from explicitly
pending post-merge operational criteria. A pass certifies the PR's complete approved implementation
and merge eligibility, not unperformed deployment or issue completion; each pending criterion must
have the follow-through required below. A new push invalidates every earlier verdict.

## CI evidence and performance

This section owns the repository's four-boundary CI policy; the planner and gate registries are its
executable mapping.

1. **Local work.** Start with `bun run ci:plan`. Inspect changed files, risk and reasons before
   editing, then use `bun run ci:check` for the mandatory build/types/style/smoke/targeted baseline
   and run direct proof of the affected behavior. High-risk extras remain explicit commands or CI
   evidence; the local alias does not call them silently.
2. **Pull-request integration.** CI always runs the baseline and impact-selected checks. The
   always-run required `gate` verifies that exact plan and result universe. Its green result on the
   current head and integration base permits ordinary agent merge without a local full gate or a
   wait for post-merge full CI; the required context and current-base protection are unchanged.
   Missing or invalid diff evidence fails closed. Unknown impact, dependency-graph holes, and
   authentication, persistence, execution, deployment, workflow, toolchain or normative-contract
   changes select conservative extra/full proof and retain all applicable operator holds.
3. **Integrated `main`.** Every push to `main` and manual CI dispatch runs the complete
   [`scripts/gate.ts`](../scripts/gate.ts) registry. A running `main` proof is not cancelled by a
   newer push; a pending run may coalesce, but the in-progress revision finishes. Cancellation of
   a superseded pending revision is not a bug, while the latest full failure remains visible. This
   is asynchronous follow-through, never permission to hide a failure: `bun run ci:status` makes
   one bounded query and names failed jobs, the repair issue and next action; it does not poll.
   Trusted feedback creates/updates the bounded `p1` CI run incident with `bug`, `area:infra` and
   initially `needs-triage`, assigns a resolvable merged-PR author as triage/repair owner rather
   than alleging fault, and gives safe reproduce/repair/revert guidance. The standing operator
   scope permits `agent-ready` only after complete acceptance criteria are present. Assignment
   routes work; it does not launch a repair agent. The owner diagnoses the failure and links
   repeated occurrences to one evidenced underlying defect rather than treating every run as a
   separate bug. Exact-revision recovery closes the run incident under §Exit, not the underlying
   defect. Unrelated safe work need not freeze while the full run completes.
4. **Deployment and release.** Integrated development requires successful full `main` push or
   manual-dispatch CI evidence for its exact revision. Release starts from an exact full-`main`
   predecessor, and promotion separately
   requires full evidence for the tagged release commit. A numbered PR preview may instead use a
   successful full manual CI dispatch at that exact branch head, valid only for that preview.
   Fast PR green, stale artifacts and a later unrelated green revision are insufficient. Release,
   promotion, deployment and runtime verification retain separate authorization and evidence.

`bun run gate` remains the memory-bounded authoritative full local gate. Changes to this policy,
the planner, workflow, toolchain or gate registry require full cutover proof. Any gate-task addition
or change must update CI topology and pass `bun scripts/ci-coverage.ts`; no check or assertion may
be removed or weakened for speed without explicit operator acceptance. Full CI partitions types
into four disjoint shards while no-argument local `bun run gate` retains complete unsharded
behavior. Build consumers may use only a SHA-named artifact from the exact source tree under test.
Exact-tree artifacts expire after one day; after expiry rerun the whole workflow. Required jobs
have bounded timeouts, and the final aggregator rejects required failures and unexpected skips.
Full CI retains concurrent plain-preview and integrated-preview runtime proof, and the native
Nix package matrix on all four advertised systems. The `nix` registry group builds and explicitly
rebuilds the fixed-output dependencies before building and smoking both native compiled packages;
cached availability alone is insufficient. The full local gate therefore requires native Nix,
unlike the ordinary local baseline. Package proof does not authorize live owner activation.

Fast pull-request feedback targets **1–2 minutes**. Separately, the complete suite operates to
**under 7 minutes p95** execution wall clock over at least ten recent clean runs with sufficient
hosted-runner concurrency. Record wall clock and queue delay separately with revision, event,
attempt, per-job duration and critical path; keep retries separate. Queue growth is a capacity
incident, not permission to weaken proof.

Optional local pre-commit diff or formatting checks may shorten feedback. Repository automation
must not install hooks, change Git configuration or put the full gate in a hook; hooks are
convenience only, never security or merge enforcement.

## Merge

An agent lands a pull request by arming squash auto-merge (`gh pr merge <n> --auto --squash`),
without an additional waiting period, when **all** of these hold. The repository deletes the merged
branch, and §Runbooks › ship orders armed pull requests through its integration lane.

1. The pull request claims an open issue carrying `agent-ready` and exactly one priority label.
   Its approved implementation scope is complete. `Closes #N` or `Refs #N` follows §Pull requests;
   a `Refs` PR has a complete post-merge handoff, not missing implementation disguised as follow-up.
2. The required PR `gate` is green on the current head and integration base:
   `gh pr checks <n> --required` exits 0. Branch protection still refuses a head that is behind
   `main` at merge; a head that is green but only behind may be armed, and the lane brings it
   current.
3. The newest `## Verdict:` comment is `pass` and is dated after the head commit was pushed.
4. The change is within the current operator request or an applicable recorded standing/bounded
   grant, recorded and linked through the §Holds decision receipt. No unresolved `needs-operator` hold, design
   decision, compatibility question or material risk remains on the PR or its issue.
5. The risk plan and contract-specific verification cover the actual scope. `area:infra` and
   protected paths require the appropriate strong proof and authority assessment, not an automatic
   operator hold. This includes workflows, infrastructure, Docker/Compose, Nix, axioms, decision
   records, release/promotion tooling and authentication/identity. Existing full-cutover proof,
   axiom ratification and live-system boundaries are unchanged.

Missing implementation, CI, review or handoff blocks merge until corrected; the agent does that
work without asking the operator to waive it. A genuinely unresolved authority or risk decision
requires `needs-operator`, a draft PR and the §Holds decision block. Do not reopen an already
resolved decision solely because of a label or file path, infer permission from silence, or treat
green checks as authorization. The operator may hold any PR with `needs-operator`.

The merge grant itself does not authorize release or production promotion. The separate standing
publication grant in §Release checkpoint covers eligible delivery; `bun run promote` still requires
explicit task authorization under [`AGENTS.md`](../AGENTS.md). A merge starts asynchronous full
`main` proof. Do not wait before continuing unrelated safe work; use
`bun run ci:status -- --sha <merge-sha>` when its state is needed. Trusted feedback files a `p1`
run incident with a named triage owner for a failed or timed-out full run. Deployment/release work
must wait for the exact-revision full result. Development deployment failure tracking remains
separate and `p0`: the agent that merged the revision owns recording a failed `deploy-dev.yml` run
with its SHA, run link and named repair owner. Delegating monitoring does not leave that failure
unowned or require unrelated safe work to stop.

## Post-merge follow-through

Merge, full `main` proof, deployment and operational acceptance are separate transitions. An issue
stays open until every acceptance criterion is evidenced; neither a green run nor a merged PR
closes unmet operational work. Do not manufacture a second issue just to satisfy a closing link.

Before merging a `Refs` PR, record the following in the owning issue and link it from the PR:

- Completed acceptance and its evidence, plus the exact PR head; add the merge SHA after integration.
- Each remaining criterion, its required environment/revision and what observation will satisfy it.
- The accountable contributor or agent, the applicable authorization and excluded actions.
- The next safe action or external trigger, a bounded check/wait, and any blocker with its owner.

After merge, update that receipt with exact full-CI, deployment and runtime results separately.
Waiting for a known CI/deployment trigger does not need `needs-operator`. Keep the settled issue
`agent-ready` so dispatch can resume it; use `blocked` only for the named issue/PR dependencies in
§Label model. A failed check remains visible and owned, not retried until green or called complete.

An agent may continue independent work while a trigger is pending. Before ending its execution
pass, record the latest receipt and an explicit `Release:` for another agent to resume, unless an
active agent has accepted ownership. The accountable contributor still owns routing until the next
claim; an open issue must not depend on a vanished session or an unpublished promise to monitor.
Dispatch reads this receipt before choosing the next action, not another implementation PR.
Close the original issue only after recording evidence for all remaining acceptance.

### Release checkpoint

Each independently shipped, coherent user-visible fix or feature includes a semantic release;
merging its source alone is not delivery completion. The integration owner carries publication
through the existing `bun run release` command after the exact integrated revision passes full-main
CI and the release's compatibility, provenance and immutable-artifact checks. A set of dependent
PRs that implements one coherent change shares that checkpoint. Documentation, process, test and
gate-only changes do not independently require a release. There is no daily batching cap or
unattended scheduler: do not hold a finished fix for an unrelated feature or an arbitrary commit count.

The [standing publication decision](https://github.com/atyrode/manifold/issues/826#issuecomment-5778091821)
authorizes this release PR, its checked rebase merge, immutable artifacts and ordinary automatic
development follow-through within an otherwise authorized delivery. It does not authorize
production promotion, fleet/native-owner activation, credential changes, provider spending or
integration of a separately held implementation. A source-only/no-release or no-deployment hold
still requires its own resolution; publication must not be used to cross it.

Choose the version from the entire integrated unpublished change set, not the issue label or
number of commits. Compatible fix-only sets increment patch. Under the existing pre-1.0 policy,
additions or breaking changes increment minor; from 1.0, additions increment minor and breaking
changes increment major. Review fragment classifications before using the tool's derived level.
Do not force `patch` over an accumulated incompatible change, fabricate retrospective releases,
or rewrite published tags/changelogs. Development builds retain their commit-distance identity.

Record the release tag, exact source SHA, publication receipt and any remaining operational
acceptance on the owning issue. Release, development deployment, runtime acceptance and production
promotion remain separate facts. A technical/compatibility failure blocks publication, not its
checks: diagnose it and record the accountable next action. Independent work may proceed while
full CI or publication runs, but a handoff must name the pending release and its blocker rather
than call unreleased user-visible work complete.

## Exit

Closing as not planned requires a comment beginning `Disposition:` and naming one of:

- `duplicate of #N`
- `out of scope` — with the contract or axiom that puts it outside
- `superseded by #N` — after preserving anything unique to the closed issue
- `invalid` — with the reason

No automation closes arbitrary issues. Trusted full-`main` feedback may close its own run incident
when full verification succeeds for the **same exact revision**, retaining the original failure
and recording the successful run. This is **recovered**, not proof that an underlying bug was
fixed. A later green revision, green PR checks, or a successful unrelated workflow is not enough.
Modified or repurposed issues remain for owner review; deployment incidents and diagnosed defects
retain their own acceptance criteria. Automation never retries or reverts code.

Automatic closure requires an intact automation-owned incident body and run/SHA identity,
the generated incident title and triage/ready labels, a single valid assignee, and no comments
other than recognized recovery receipts. Editing the incident or adding diagnosis/claim comments
leaves closure to its owner. Existing recovery comments do not prevent an interrupted closure
from completing; legacy receipts receive the new recovery explanation before closure.

For a recurring failure, investigate before grouping: the same failing job name is not proof of
the same cause. Reuse one actionable defect issue per evidenced cause, link its occurrences, and
keep that defect open until its repair acceptance is satisfied even when an individual run
recovers. Historical run incidents may be closed as duplicates only after preserving their
unique evidence and routing remaining work. Do not require a code change merely to close a
recovered run. `aging` remains only a quiet-issue signal, never grounds for closure.

## Runbooks

Four procedures an agent can execute from a checkout of `origin/main` and nothing else. Each has a
thin entry point under [`.github/skills`](../.github/skills); invoke one by name where a harness
supports skills, or by saying "follow docs/TRIAGE.md §Runbooks › <name>".

### triage

1. `bun scripts/triage-policy.ts --fix`, then `--report`. Repair by hand every violation the fix
   pass left: choose the state, name the blocker, write the decision block.
2. For each `needs-triage` issue, oldest first:
   - Check for duplicates: `gh issue list --search "<key terms>" --state all`.
   - Check scope against [`AXIOMS.md`](../AXIOMS.md) and [`CONTRACTS.md`](CONTRACTS.md).
   - Ensure `## Problem` and `## Acceptance` exist. If you filed it, write them with
     `gh issue edit --body-file`; otherwise ask for them in a comment and leave `needs-triage`.
   - Assign type, area and priority, then exactly one state: `agent-ready`, `blocked` (naming
     `#N`), `needs-operator` (writing the decision block), or close with `Disposition:`.
3. Holds pass. List every `needs-operator` issue and write a decision block for each that lacks
   one, researching the code and docs so the options are concrete rather than "what should we do".
   With the operator present, use the interactive question tool when available; then record each
   technical outcome as a `## Decision recorded (<date>)` comment without private conversation or
   personal context, and apply `Unblocks`. With no
   operator in the session, skip the questions; the blocks are still written. Never continue held
   implementation while waiting.
4. `bun scripts/triage-policy.ts --flow`. End with the digest and the flow snapshot.

### dispatch

1. `bun scripts/dispatch.ts --next --limit 5`. If it reports non-draft PRs, run **review** or
   **ship**, correct the PR, or route its operator hold; do not claim new work. Otherwise take items
   up to the two-claim limit.
2. Read each issue's latest claim and follow-through before starting; respect existing ownership
   and post a `Claim:` for the phase being resumed. If its implementation is merged, check the
   recorded trigger once and resume the authorized operational action; do not duplicate the merged
   implementation. If operational proof exposes a defect, a scoped repair PR may `Refs` the same
   issue, or link a separate repair issue; normal ownership, review and verification still apply.
   If the trigger is pending, update the receipt, release the execution claim and consider other
   ready work in this pass rather than polling or requesting approval.
   For implementation work, create a worktree from `origin/main` — or the declared
   dependency PR's head for a real stack — inspect `bun run ci:plan`, implement to the acceptance
   criteria, run `bun run ci:check` plus direct affected-behavior proof, push, and open the single
   draft per §Pull requests. Mark it ready once the selected pushed-head PR `gate` is green, then
   run **review** and **ship** without returning to dispatch. Do not wait for full post-merge CI for
   ordinary work.
3. If implementing reveals a decision is needed, post `Release: needs decision`, relabel the issue
   `needs-operator`, write the decision block, keep any PR draft and stop. A guess is not a decision.

### review

Read the issue's acceptance criteria, the diff, planner risk/reasons, local affected proof, selected
PR CI evidence and the contract sections the change touches. Post the single `## Verdict:` comment
described in §Pull requests. Review reads and writes one comment; it does not push to the branch.
A pass hands the same head directly to **ship**; it never starts another dispatch.

### ship

For each open non-draft pull request outside the integration lane, evaluate every §Merge
criterion — `gh pr view <n> --json body,labels,files,headRefOid,closingIssuesReferences,comments,isDraft`,
its claimed issues (including `Refs`, which `closingIssuesReferences` omits), the applicable grant
and `gh pr checks <n> --required`. Then arm `gh pr merge <n> --auto --squash`, which enters the
lane, or record the failed criterion and next action. Repair technical/evidence gaps; only a
concrete unresolved operator decision gets `needs-operator`, draft and a decision block. File paths
alone are not that decision.

Branch protection requires checks on a head that is current with `main`, so each merge leaves every
other armed pull request behind. The integration lane spends one catch-up per merge instead of
racing them all. Its members are the open non-draft pull requests with squash auto-merge armed
whose newest `## Verdict: pass` is dated after their head commit, the membership
`bun scripts/dispatch.ts --next` treats as drained. The head-of-line is the member armed earliest
(`autoMergeRequest.enabledAt` in `gh pr list --json number,isDraft,autoMergeRequest`).

1. Only the head-of-line is updated from `main` (`gh pr update-branch <n>`) and rerun: by its
   owner, with a comment requesting it on another owner's branch. Younger members neither update
   nor rerun until it merges or leaves the lane. GitHub may still merge a younger member that is
   already current; that costs the head-of-line one more catch-up, not its place.
2. After a conflict-free update, the reviewer posts a refreshed verdict for the new head citing
   patch identity with the reviewed change; auto-merge stays armed and merges once required
   checks pass. A conflicted update is a correction.
3. A head-of-line failure is diagnosed in the same pass, never left to block the lane. A failure
   of the change or of its integration with `main`, a correction, or an update its owner has not
   made by the next pass takes it out: disarm with `gh pr merge <n> --disable-auto`, comment the
   failure and next action, and return it to draft when it needs correction. An evidenced
   unrelated failure gets one recorded rerun; a repeat takes it out the same way. It re-enters at
   the back by re-arming once it again meets §Merge.

The release command's rebase-auto-merged pull request is not a lane member and blocks dispatch
until it lands.

Lane merges land asynchronously, so each ship pass first reconciles pull requests merged since the
last one. For each merge, update the owning issue's §Post-merge follow-through with the merge SHA
and let full `main` CI continue asynchronously; do not block independent safe work on it. Trusted
feedback assigns any failed full run to its repair owner. Deployment or release operators must
query that exact SHA and wait for its successful full proof. Then list dependent open PRs. Rebase
and reverify branches you own; for another owner, comment the merged revision and required base
update. Close an empty or superseded draft only after preserving unique work and recording its
destination. Do not return to dispatch until this reconciliation is complete.

## Flow

`bun scripts/triage-policy.ts --flow` prints the weekly snapshot: issues opened and closed per day,
the open tracker by state, and the oldest `needs-triage` issue. There is no second tracker and no
spreadsheet.
