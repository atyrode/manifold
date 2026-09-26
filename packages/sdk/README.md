# External actions, without browser control

Effects on a live Manifold go through discovered action doors. Drive DOM controls only when
verifying the human-facing interaction itself. The SDK's `manifold-action-runner` is the
supported bounded external process; no browser session or handwritten HTTP is needed.

## Trusted launcher

Use the repository's supported Bun (at least 1.4.2) and installed workspace dependencies:

```sh
bun packages/sdk/src/action-runner-main.ts --help
bun packages/sdk/src/action-runner-main.ts
```

The package also declares the `manifold-action-runner` executable. Before starting it, the
**trusted launcher**, not the agent's prompt or JSON stream, supplies:

- `MANIFOLD_ORIGIN`: one authorized HTTP(S) origin, without a path, username, password,
  query, fragment or credential-bearing link.
- Exactly one binding:
  - **Agent mode (Babel/external orchestrators):** `MANIFOLD_RUNNER_TOKEN`, the Agent-scoped
    `agents:run` credential, and `MANIFOLD_AGENT_ID`. Optional `MANIFOLD_AGENT_SESSION` is
    JSON `{harness,sessionId,machineId}` supplied by the trusted harness, and optional
    `MANIFOLD_AGENT_MODEL` is JSON `{provider,model}`. The runner calls `core.access.createRun`
    under the existing standing grant; it cannot create or broaden that grant.
  - **Run mode (OMP/terminal admission):** `MANIFOLD_RUN_TOKEN` and `MANIFOLD_RUN_ID`, injected
    through the hub's private machine channel. The runner adopts that already-admitted run
    through `core.access.inspectRun`; it does not create another run.
- Optional `MANIFOLD_ACTIVITY_FD`: a separately inherited harness pipe descriptor, at least 3.
  Do not give that pipe to the model.
- Optional `MANIFOLD_READ_RESULTS`: JSON array of at most 64 unique exact-door approvals,
  each `{door,contractDigest,maxResultBytes?}`. The digest pins the reviewed live
  `resultProjection` declaration; the optional byte limit may only narrow it. No wildcard
  or model-supplied approval is accepted. Omit this configuration for mechanical-only output.

The runner reads and deletes all inherited binding and read-result entries, including secrets, before reading
either pipe. Mixing modes, partial bindings and the old `MANIFOLD_SPONSOR_TOKEN` are refused.
For example, Babel registers `babel-analyst` once, retains its runner credential in its secret
store, and launches an Agent-mode runner per analysis. OMP's `launchRun` instead prepares the
transcript session and terminal admission supplies the Run-mode environment. Neither example
puts a bearer in a shell command, argv, JSONL, a prompt, a log or a file.

The Agents sidebar displays the runner credential only after first registration, alongside
the Agent ID. Copy it into the trusted launcher's secret store before choosing **Hide
credential**, leaving the section, or reloading. The sidebar does not persist the handoff.
Clipboard refusal leaves a selectable field for manual copy. The credential cannot be
retrieved or re-issued: repeating registration with the same sponsor/name returns the
existing Agent without a credential, and renewing a Run does not replace its runner
credential. If it is lost, the sponsor must explicitly retire the unusable Agent and
register a replacement under a different name, reviewing its grant again. Retirement
preserves the old Agent's history; this UI does not perform that recovery automatically.

Agent-mode renewal and cleanup retain the scoped runner credential; Run-mode renewal replaces
its own private bearer. Neither cleanup retires the Agent or withdraws the runner credential.
Child credentials and replacements never leave the process. The trusted launcher must isolate
its process memory/environment from the external agent; JSONL is the agent-facing interface,
not a sandbox for arbitrary code running as the launcher's OS user. For a preview, the launcher
needs an authorized Agent/run credential **on that preview**. Human production-to-preview browser sign-in
is unchanged and is not an automation enrollment shortcut.

The runner accepts no argv except `--help`, never follows HTTP redirects and never uses browser
ambient credentials. Each input is one complete UTF-8 JSON object followed by a newline. Frames
are strict, at most 64 KiB, with unique `id` values matching `[a-zA-Z0-9_-]{1,64}`. Process only
one request at a time: one request may produce multiple response frames. There are at most 1024
requests, five minutes idle, one hour total process lifetime and 30 seconds per HTTP request.
HTTP responses and each outgoing JSONL frame (including its newline) are bounded to 16 MiB;
queued output is bounded too. Consume stdout promptly: more than 16 MiB of pending output
terminates the run with a limit error and attempts cleanup, even if each individual frame fits.

## First action

Admission is automatic from the trusted binding, before stdin is consumed. There is no `start`
or `bind` model frame, and the model cannot select a different Agent or invent a session.

1. Read `discovery`: its `actions` are the live installed doors and their exact input/result
   schemas and metadata. Incompatible protocol versions, duplicate names and malformed
   discovery stop the runner. Discovery authenticates with the launcher-supplied credential.
2. Read the `result` for `core.access.createRun` (Agent mode) or `core.access.inspectRun`
   (Run mode). Its `runId` is a non-secret handle, not a credential. Launcher-driven responses
   use `id: null`; newly admitted runs begin in `pending_policy`.
3. Read the `policy` frame. Deliver **every exact `policy.required[].body`** to the acting
   agent. Policy source selection is the server's; repository text cannot replace it.
   The runner verifies each body's SHA-256 digest and never silently redacts policy bytes.
4. Send `ack` with that `runId`, the exact `policy.revision`, and
   `policy: { revision, acknowledgements: [{ id, digest }, ...] }` copied from all the
   delivered bundles. Missing, duplicate, extra or mismatched acknowledgements cannot
   activate ordinary invocation. Acknowledgement proves delivery/assent, not comprehension,
   hidden reasoning or future compliance.
5. Choose a door from discovery and send `invoke` with `id`, `runId`, `door`, a canonical
   `manifold://` `target`, and `args` matching its published schema. The server door performs
   the actual schema validation and authorization, preserving its structured refusal rungs.
   Optional `justification` (maximum 512 characters) is sent as
   `x-manifold-agent-justification` using the protocol's `v1.` + `encodeURIComponent` ASCII
   codec, preserving Unicode and line breaks through HTTP decoding. The decoded dispatch option
   is reserved for #557's normalization, validation, persistence and attribution; it never grants
   additional permission. Malformed wire encoding is invalid input, not an absent claim.
6. Retain the returned door, declared target, mechanical outcome/refusal and durable numeric
   `traceId`. Finish the root run with the truthful terminal outcome before closing stdin.

Never supply credentials in frames, including opaque action arguments. The runner rejects
secret-bearing fields, bearer/key-link carriers and every held launcher/child bearer value.
Policy digests and artifact hashes are not credentials and remain usable as typed door input;
they are never authority. This runner is not a secret-injection mechanism for plugin calls.

## Frame contract

`id` is required on every request. `runId` always names a run owned by this runner.
Launcher-only admission finishes before model frames are consumed.

| Request `type` | Additional fields                                                 | Behavior                                                                                 |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `discover`     | `runId`                                                           | Refresh the installed vocabulary; no compiled per-plugin bindings                        |
| `policy`       | `runId`                                                           | Deliver the current challenge; explicitly ack before ordinary work resumes               |
| `ack`          | `runId`, `policy: {revision, acknowledgements:[{id,digest}]}`     | Acknowledge exactly the delivered challenge through its action door                      |
| `invoke`       | `runId`, `door`, `target`, `args`, optional `justification`       | Invoke a discovered ordinary door; lifecycle doors cannot be smuggled through this frame |
| `child`        | parent `runId`, `declaration`, optional `justification`           | Narrow authority within the same Agent; return a distinct run id and policy challenge    |
| `renew`        | child's or root's `runId`, `lifetimeMs`, optional `justification` | Renew through the authorized retained credential and replace the private bearer          |
| `finish`       | `runId`, `outcome`                                                | Settle that subtree; finishing the root closes the process                               |

Terminal outcomes are `completed`, `failed`, `cancelled` and `abandoned`. Children use their own
acknowledgement and run handles; neither child creation nor renewal exports a bearer. The server
still enforces attenuation, depth/descendant budgets, renewal ceilings and live sponsor authority.
Renew parent and child deliberately: changing a sponsor credential changes live lineage and may
require renewed child authorization. A `policy_stale` refusal includes its trace id and is followed
by the new exact challenge; explicitly acknowledge it before retrying, with no auto-assent.

A child declaration may narrow `caps`, `target`, `reach`, `lifetimeMs` and `delegation`, or
supply the external harness's `taskRef`. It cannot name `agentId`, `session` or `model`; those
bindings belong to the launcher, never a model frame.

The trusted harness writes `{runId,activity:"working"|"blocked"|"done"|"idle"}` JSONL to the
separate activity pipe, or calls `ActionRunner.reportActivity` in-process. Reports invoke
`core.access.reportRunActivity` with the owned run's credential. The pipe uses the same 64-KiB
UTF-8 framing, has its own 1024-frame limit, and shares the serialized executor and process
lifetime. Closing only the activity pipe does not finish work; model stdin EOF does. Activity
does not acknowledge policy or settle a run, and is never inferred from terminal output.
The model cannot write activity through stdin or smuggle the activity door through `invoke`.

Responses are strict `discovery`, `policy`, `result`, `error` or `closed` objects, described by
`ActionRunnerResponseSchema` in `@manifold/protocol`. `result.outcome` is `{ok:true}` or
`{ok:false,denial:{rule}}`. It deliberately excludes raw action results and free-form denial
messages, which can contain credentials, arguments, environment, terminal contents or output.
Lifecycle results additionally carry expiry or confirmed cleanup counts. The result's `target`
is **caller-declared**, not an assertion about the trace's resolved targets. Inspector/SDK readers
use the durable trace reference rather than inferring facts from arguments.

### Opting into bounded read results

An ordinary action may declare `resultProjection`:

```json
{
  "kind": "projected-json",
  "fields": [
    ["items", "*", "text"],
    ["items", "*", "sourceId"]
  ],
  "textFields": [["items", "*", "text"]],
  "maxArrayItems": 20,
  "maxResultBytes": 32768
}
```

These are selected **primitive leaves**, not permission to return arbitrary subtrees. A `*`
traverses array items only. A declaration has at most 64 paths, each at most 16 segments,
and at most 4096 items per array; traversal is bounded to 65536 nodes. Its byte ceiling is
at most 1 MiB of serialized UTF-8 data. Missing fields are omitted; a selected object or
array leaf is refused. Optional `textFields` uses the same path grammar and count limit and
must name **exact leaves already selected by `fields`**, not prefixes, additional paths or
arbitrary subtrees. Those leaves accept only strings or `null`; missing values remain omitted.
Without `textFields`, existing declarations and their digests are unchanged.

Publication selection is not authorization, sensitivity classification or redaction, and does
not promise that the action is mutation-free. The owning domain/plugin must perform
subject-level disclosure checks and redact sensitive material before returning its result.

The trusted launcher reviews the declaration and computes
`await actionResultProjectionDigest(declaration)` from `@manifold/protocol`, then supplies
that digest with the exact door through `MANIFOLD_READ_RESULTS` (or `ActionRunner`'s
`readResults` constructor option). Review the **exact declaration, including `textFields`**:
adding or changing textual leaves changes the digest and requires a new trusted approval.
This is not an instruction to automatically approve whatever discovery returns. The model
cannot request a new projection, declare text fields or widen a reviewed one.
No declaration means `projection_unavailable`; a changed digest means `projection_changed`,
both before invocation. Refreshing discovery does not update the trusted approval.
The approval applies to every owned, policy-acknowledged run in this runner process, including
attenuated children; each invocation still passes that run's own current authority checks.

For an approved invocation, the SDK sends the expected digest in
`x-manifold-result-projection`. The host checks it after ordinary authority/input admission
and before effects; a stale or unsupported request is a traced `invalid_args`. No requested
digest means no projection calculation. Normal trusted clients still receive the ordinary
full result, and sibling action calls remain unchanged.
Projection observes JSON wire values in both execution modes: omitted optional values remain
absent, and a value's JSON representation (such as a date string) is what the leaf selector sees.

A successful runner `result` may additionally contain:

```json
{
  "projection": {
    "ok": true,
    "contractDigest": "<the approved 64-character lowercase SHA-256>",
    "trust": "untrusted",
    "data": { "items": [{ "text": "archived source text", "sourceId": "example" }] }
  }
}
```

The runner accepts only the host's separate sideband with that digest and a real trace id,
reprojects the declared fields, and independently checks structural and UTF-8 byte bounds.
Its credential walk inspects the **complete sideband**, including unselected data. Every held
launcher, child and replacement credential value is always rejected, as are forbidden credential
key names and lexical carriers in keys. Only string values at exact reviewed `textFields` leaves
skip the lexical bearer/key-link/URL-userinfo pattern checks. This permits literal or redacted
source text such as `Bearer [REDACTED]`, a username-only URL or a redacted token query without
rewriting, escaping or encoding its bytes. Neighboring fields and unselected values retain
their lexical guards; marking a leaf never exempts an object, array or subtree.

These checks are defense in depth, not a classifier for every possible secret. The owning
domain remains responsible for redaction; declaring text does not make source content safe.
There is no raw-result fallback or truncation, and model input credential checks are unchanged.
Source text remains untrusted data: it cannot become policy, an acknowledgement, an activity
frame or a credential binding. Lifecycle output never carries a projection.

If an effect succeeds but its publication fails, `outcome` remains `{ok:true}` and `projection`
instead contains `{ok:false,contractDigest,trust:"untrusted",code:"projection_invalid"}` or
`"projection_limit"`. The action's success, events and trace remain truthful; rejected bytes are
not returned in the projection. A narrower launcher byte ceiling may refuse an otherwise valid
host projection. Do not automatically retry: the action may already have had an effect.
Action refusals do not carry projections. Missing trace or malformed transport remains an
ordinary runner error, never a fabricated successful result.

The lower-level `@manifold/sdk` exports `discoverActions` and `invokeAction` for trusted in-process
consumers. `invokeAction` returns the complete existing `ActionOutcome` together with
`traceId: number | null`; `ActionHttpError` also carries an available durable reference. Ordinary
`SessionClient.action` and plugin-kit dispatch preserve their existing outcome-only interface.
The shared transport has no implicit timeout or response ceiling; trusted callers opt into
`timeoutMs`, `signal` and `maxResponseBytes`. The runner explicitly supplies its 30-second and
16-MiB bounds. Plugin-kit retains its pre-existing 30-second action deadline.
An unknown action or a failure before dispatch does not acquire a synthetic trace id.

## Finish and failure

Read the final `closed.cleanup`, not merely a zero-sized pipe or an HTTP 200:

- `confirmed`: the existing finish door confirmed settlement and credential revocation.
- `failed`: settlement is unconfirmed. Report the run id and failed operation; do not call it clean.
- `not_started`: no root run was created or ambiguously admitted.

The process exits zero only after explicit `completed` with confirmed root cleanup. EOF before
finish means `abandoned`; malformed JSON/frames or transport failure mean `failed`;
SIGINT/SIGTERM/SIGHUP mean `cancelled`. Signals wait for the bounded in-flight request so a newly
created run can still be identified and finished. Descendants are settled transitively by the root
finish door. Expiry remains a backstop for network loss, lost creation replies and uncatchable
termination such as SIGKILL; it is never reported as successful teardown. A reported action refusal
is data and does not itself end the run.
