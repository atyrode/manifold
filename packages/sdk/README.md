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
- `MANIFOLD_SPONSOR_TOKEN`: a process-owned sponsor credential from the launcher's secret
  store. Never paste its value into argv, a shell command, JSONL, a prompt, logs or files.

The runner reads and deletes the inherited secret environment entry before reading stdin.
The original sponsor is retained only in private process state and is never a teardown target.
An accountable-agent launcher is supported: the runner's first owned run can be a server-side
child, and renewal/finish still use the retained launcher credential. The launcher retains
responsibility for its own run and policy acknowledgement; the runner never finishes it.
Child credentials and replacements never leave that process. The trusted launcher must isolate
its process memory/environment from the external agent; JSONL is the agent-facing interface,
not a sandbox for arbitrary code running as the launcher's OS user. For a preview, the launcher
needs an authorized sponsor **on that preview**. Human production-to-preview browser sign-in
is unchanged and is not an automation enrollment shortcut.

The runner accepts no argv except `--help`, never follows HTTP redirects and never uses browser
ambient credentials. Each input is one complete UTF-8 JSON object followed by a newline. Frames
are strict, at most 64 KiB, with unique `id` values matching `[a-zA-Z0-9_-]{1,64}`. Process only
one request at a time: one request may produce multiple response frames. There are at most 1024
requests, five minutes idle, one hour total process lifetime and 30 seconds per HTTP request.
Responses are bounded to 16 MiB; a blocked output reader also terminates boundedly.

## First action

Send a declaration containing the task's truthful purpose and its approved ceiling, for example:

```json
{
  "type": "start",
  "id": "start",
  "version": 1,
  "declaration": {
    "name": "workspace reader",
    "purpose": "Read the approved workspace inventory.",
    "taskRef": "issue:553",
    "target": "manifold://",
    "reach": "subtree",
    "caps": ["containers:read"],
    "lifetimeMs": 60000
  }
}
```

1. Read `discovery`: its `actions` are the live installed doors and their exact input/result
   schemas and metadata. Incompatible protocol versions, duplicate names and malformed
   discovery stop the runner. The discovery request itself carries sponsor authentication.
2. Read the `result` for `core.access.createAgentRun`. Its `runId` is a non-secret handle,
   not a credential. Creation remains sponsor-authorized and starts in `pending_policy`.
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
secret-bearing fields, bearer/key-link carriers and every held sponsor/child bearer value.
Policy digests and artifact hashes are not credentials and remain usable as typed door input;
they are never authority. This runner is not a secret-injection mechanism for plugin calls.

## Frame contract

`id` is required on every request. `runId` always names a run owned by this runner.
`start` occurs once; every other operation follows it.

| Request `type` | Additional fields                                                 | Behavior                                                                                 |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `start`        | `version: 1`, `declaration`, optional `justification`             | Discover, create the root run, deliver exact policy                                      |
| `discover`     | `runId`                                                           | Refresh the installed vocabulary; no compiled per-plugin bindings                        |
| `policy`       | `runId`                                                           | Deliver the current challenge; explicitly ack before ordinary work resumes               |
| `ack`          | `runId`, `policy: {revision, acknowledgements:[{id,digest}]}`     | Acknowledge exactly the delivered challenge through its action door                      |
| `invoke`       | `runId`, `door`, `target`, `args`, optional `justification`       | Invoke a discovered ordinary door; lifecycle doors cannot be smuggled through this frame |
| `child`        | parent `runId`, `declaration`, optional `justification`           | Sponsor an attenuated child; return its non-secret run id and its own policy challenge   |
| `renew`        | child's or root's `runId`, `lifetimeMs`, optional `justification` | Invoke renewal as the retained direct sponsor and replace the private bearer             |
| `finish`       | `runId`, `outcome`                                                | Settle that subtree; finishing the root closes the process                               |

Terminal outcomes are `completed`, `failed`, `cancelled` and `abandoned`. Children use their own
acknowledgement and run handles; neither child creation nor renewal exports a bearer. The server
still enforces attenuation, depth/descendant budgets, renewal ceilings and live sponsor authority.
Renew parent and child deliberately: changing a sponsor credential changes live lineage and may
require renewed child authorization. A `policy_stale` refusal includes its trace id and is followed
by the new exact challenge; explicitly acknowledge it before retrying, with no auto-assent.

Responses are strict `discovery`, `policy`, `result`, `error` or `closed` objects, described by
`ActionRunnerResponseSchema` in `@manifold/protocol`. `result.outcome` is `{ok:true}` or
`{ok:false,denial:{rule}}`. It deliberately excludes raw action results and free-form denial
messages, which can contain credentials, arguments, environment, terminal contents or output.
Lifecycle results additionally carry expiry or confirmed cleanup counts. The result's `target`
is **caller-declared**, not an assertion about the trace's resolved targets. Inspector/SDK readers
use the durable trace reference rather than inferring facts from arguments.

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
