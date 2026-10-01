# External actions, without browser control

Effects on a live Manifold go through discovered action doors. Drive DOM controls only when
verifying the human-facing interaction itself. Ordinary terminal-local processes use the
terminal plugin's SDK-backed `manifold` client; external Agent/Run processes use the SDK's
`manifold-action-runner`. Neither needs a browser session or handwritten HTTP.

## Ordinary terminal-local client

Install the compiled package from the same release as the hub:

```sh
nix profile install github:atyrode/manifold/<release-tag>#manifold
manifold context
manifold doctor
manifold actions
manifold machines
```

An ordinary terminal lifecycle binding retains local inspection and terminal control, but
does **not** authorize another shell. For remote automation, an authorized human uses
Access → Sessions to mint a finite V2 credential with working placement rights and
`machines:shell` at one exact enrolled machine/account. Its trusted launcher provisions
the binding through the owning tool, never argv, prompts, a copied browser token or an
Agent identity workaround. Then:

```sh
manifold ssh <explicitly-delegated-machine-id> uname -srm
manifold ssh <explicitly-delegated-machine-id> 'wc -c' < local-file
manifold exec --machine <explicitly-delegated-machine-id> -- /bin/sh -c 'printf "remote output\n"'
```

The client privately consumes the ordinary terminal's inherited `MANIFOLD_URL`,
`MANIFOLD_CONTAINER` and `MANIFOLD_TOKEN`. Do not print them, put them on argv, copy another
principal's credential or register a Run to replace a valid terminal binding. An Agent/Run
binding belongs to the runner below. The current session protocol must match the hub;
upgrade the hub and client together rather than spoofing a version. Compatible older
machine transports do not need an unrelated owner restart.

`ssh` and `exec` select one explicitly named online unconfined Unix/WSL machine, create
only their own terminal with a virtual viewport, attach and confirm control before
releasing the command. They never fit another viewer's pending leaf or replay a command
after uncertain completion. `--timeout-ms` and `--max-output-bytes` bound the operation.
Cancellation or removal without a confirmed owner exit does not prove the process stopped.

`ssh` is the ordinary way to run a remote command, shaped like OpenSSH's client. Options
come before the machine; the command words after it are joined with single spaces and run
by `/bin/sh -c`, and a missing command is refused (no login sessions). The command's
stdin, stdout and stderr are pipes, never the terminal, so Windows console programs reached
through WSL interop behave as they do under a pipe instead of waiting for a terminal reply.
Remote stdout is written to local stdout byte for byte and remote stderr to local stderr:
the wrapper sends stderr as `od` hex records tagged with a per-run key, each one atomic write
into the pipe that carries raw stdout through a `-opost` PTY. The key travels on terminal
input rather than argv (a raced echo of that line is discarded setup noise); it keeps command
bytes from being mistaken for framing, and it is not a secret from the command, whose forged
record could only move its own bytes to stderr. Local stdin that is not a terminal is read to
end of file (1 MiB by default, `--max-input-bytes` up to 16 MiB; more is refused before
anything starts), sent in paced base64 chunks and closed; `-n`, or a terminal stdin, gives
the command `/dev/null`. `-t` instead runs the command on the terminal, with exec's merged
raw PTY bytes on stdout and no stdin; as an asynchronous command there it starts with SIGINT
and SIGQUIT ignored. The exit status is the one in the owner's exit event (128+N after signal
N); no framed byte can claim a status. The wrapper stays the terminal's leader: when a run is
stopped (deadline, output bound, cancellation) the agent's kill reaches it, and it sends TERM
to the command's process group and KILL 2 s later. After the run, local stdout and stderr get
10 s to take the remaining output. Every Manifold-side failure, a failed or stalled local
output included, exits 255 with one secret-free `manifold: <code>: <message>` line on stderr,
and `--receipt <path>` writes the JSON result once local output has settled (mode 0600,
never replacing an existing path). Targets need `/bin/sh`, `stty`, `od` and `dd`, plus
`base64` to forward stdin; a missing tool is refused by name before the command starts.

`exec` keeps the structured envelope: direct argv, no stdin, and a JSON receipt with owned
PTY output as base64, whether output is complete, observed command completion, controller
status, action trace IDs and cleanup evidence. That is a terminal stream, not separate
lossless stdout/stderr or an RPC exit status inferred from an HTTP success.

An absent executable is an installation failure. `doctor` distinguishes missing bindings,
protocol skew, authentication and missing/disabled core doors; `ssh` and `exec` separately
diagnose the selected machine's suitability. A missing harness-specific tool does not
establish that core access is unavailable. Terminal access is not Windows desktop or game
control.

`doctor` reports remote shell launch as `not_probed`; it never creates a terminal to test
delegation. A lifecycle binding's `ssh`/`exec` refusal is `shell_spawn_not_delegated`,
requiring `terminals:spawn` at placement and `machines:shell` at the exact account.
Workspace working authority supports composition and independent canvas homes; one-C
authority supports only that existing composition's tile path. Terminal control is separate:
a workspace `terminals:write` grant may reach an existing PTY on another machine, so an
M1 creation grant is not blanket “M1-only machine access.”

The package installs its product-owned skill at
`share/agent-skills/manifold-terminal/SKILL.md`. A machine's configuration owner should
install the executable and expose that same skill through its managed harness loaders.
Default/global agent context should route a terminal-bound process to `manifold context`
even outside this checkout. Installing files does not update an already-running agent's
loaded context; verify a fresh session through the actual harness loader.

From a development checkout, the equivalent entrypoint is
`bun packages/plugins/terminals/cli/main.ts`; it consumes only public SDK exports.

## Active terminal viewport measurements

After `attachTerminal` and the ordered snapshot handoff, an eligible controller-principal
view publishes **desired** cell space with `resizeTerminal(terminalId, cols, rows, viewportId)`.
Each mount owns a unique opaque id. The public three-argument form uses the client's single
virtual `sdk` viewport. Renew only foreground visible intent every
`TERMINAL_VIEWPORT_REFRESH_MS` (10 seconds); stale measurements expire after
`TERMINAL_VIEWPORT_LEASE_MS` (30 seconds). Call
`releaseTerminalViewport(terminalId, viewportId)` on hiding or disposal, separately from
refcounted `detachTerminal`. Offline measurements and withdrawals are not queued for replay.
The pending tiled terminal's first writable measured view still supplies birth geometry.

The server derives the minimum desired columns and rows independently over eligible LIVE
occupant views. Read-only, non-controller and preview views cannot constrain the grid.
With no eligible view, the server retains the last applied grid. `terminalSizing` holds ephemeral
`terminal_sizing` attribution (`mode`, column/row connection+viewport references), while
`terminals` and `resized` events remain the authoritative applied geometry. Attribution
references are not authority or private identity; name them only through already-visible
attendance. This session-only revision does not require a native owner or fleet restart.
Native resize admission failure also retires sizing intent and retains the last successful grid;
only a fresh eligible measurement can enter again. Do not describe an unapplied desired size
as the shared grid.

## Live session authority and feeds

`SessionClient.workspaceCaps()` reports live effective engine caps at the workspace root
for its actual physical connection credential. `workspaceEventsAvailable()` reports coarse
workspace-event eligibility. Unknown/disconnected authority is empty/false; room `selfCaps()`
and the mounted container do not answer either question. `onAuthorityChange(callback)`
returns its release and calls back after current getters update, without replacing the client.
Late room/observer handles inherit the current snapshot before readiness. A pooled handle and
its pre-connect subscriptions are installed before synchronous readiness listeners run, so those
listeners may safely add interests and request a fence. Retirement callbacks may reconnect the
handle without the retired attachment clearing its successor's authority.

After `subscribe(topics, handler)`, await `syncSubscriptions(): Promise<boolean>` before the
catch-up read that switches a feed to event-only mode. Its five-second deadline starts at invocation,
including time queued behind an earlier watermark; queue promotion does not extend it. This is a
socket ordering fence, not a subscription acknowledgement: the server replies identically for
accepted and refused topics and reveals no per-topic admission. The physical pool coalesces
requests by generation, authority epoch and declaration watermark; an earlier reply cannot cover later
interests. False means retain fallback polling. Rebind/disconnect/authority retirement clears
the proof, and gaining workspace-event access re-declares all retained interests.

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
