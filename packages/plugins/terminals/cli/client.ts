import { randomBytes, randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import {
  MAX_TERMINAL_ARG_CHARS,
  MachinesResponseSchema,
  PROTOCOL_VERSION,
  TerminalInfoSchema,
  TerminalProgramSchema,
  type ActionProtocol,
  type MachineSummary,
  type PluginRoster,
  type TerminalExitReason,
} from "@manifold/protocol";
import {
  ActionHttpError,
  ActionProtocolError,
  SessionClient,
  SessionConnectionError,
  discoverActions,
  invokeAction,
  type ActionHttpOptions,
} from "@manifold/sdk";

const HTTP_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1_048_576;
const CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 16 * 1_048_576;
const DEFAULT_INPUT_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 16 * 1_048_576;
/** A multiple of 3, so paced chunks concatenate into one unpadded base64 stream. */
const INPUT_CHUNK_BYTES = 98_304;
/** Setup noise (a raced echo) tolerated before the start frame; never command output. */
const MAX_DISCARDED_BYTES = 8192;
const BINDING_KEYS = ["MANIFOLD_URL", "MANIFOLD_CONTAINER", "MANIFOLD_TOKEN"] as const;
const RUN_KEYS = [
  "MANIFOLD_RUNNER_TOKEN",
  "MANIFOLD_AGENT_ID",
  "MANIFOLD_AGENT_SESSION",
  "MANIFOLD_AGENT_MODEL",
  "MANIFOLD_RUN_TOKEN",
  "MANIFOLD_RUN_ID",
  "MANIFOLD_ORIGIN",
  "MANIFOLD_SPONSOR_TOKEN",
  "MANIFOLD_ACTIVITY_FD",
  "MANIFOLD_READ_RESULTS",
] as const;
const EXEC_DOORS = [
  "core.machines.list",
  "core.terminals.create",
  "core.terminals.take",
  "core.terminals.kill",
] as const;

const HELP = `manifold — terminal-local, scoped SDK client

Usage:
  manifold doctor
  manifold context
  manifold actions
  manifold machines
  manifold ssh [-n] [-t] [--timeout-ms <n>] [--max-output-bytes <n>]
    [--max-input-bytes <n>] [--receipt <path>] <id-or-exact-name> <command...>
  manifold exec --machine <id-or-exact-name> [--cwd <path>]
    [--timeout-ms <n>] [--max-output-bytes <n>] -- <argv...>
  manifold --help

Use only the injected MANIFOLD_URL / MANIFOLD_CONTAINER / MANIFOLD_TOKEN terminal
binding. Never put credentials in arguments, prompts, files or diagnostics. Agent
and Run environments use manifold-action-runner instead; this command never admits
a run, mints credentials, borrows another identity or retries an effect.

Targets must be Unix or WSL with /bin/sh and POSIX stty; ssh also needs od and dd,
and base64 when stdin is forwarded. A missing tool is refused with a named
diagnostic before the command starts. Native Windows is not supported. Select an
online, unconfined machine by ID or exact unambiguous name; no fallback machine is
selected.

ssh is the ordinary way to run a remote command. Options come before the machine;
the words after it are joined with single spaces and run by /bin/sh -c on the
target. A command is required: interactive login sessions are not supported. By
default the command's stdin, stdout and stderr are pipes, never the terminal:
remote stdout is written to stdout byte for byte, remote stderr to stderr, and
nothing else reaches stdout. The exit status is the remote command's (128+N after
signal N), taken from the owner's exit event. Local stdin that is not a terminal is
read to end of file before the command starts and forwarded, then closed; more than
--max-input-bytes (1048576 by default, at most 16777216) is refused before anything
starts. With -n, or when stdin is a terminal, the command reads /dev/null; pass -n
when stdin is an open pipe carrying no input. -t runs the command on the terminal
as exec does: stdout and stderr merged as raw terminal bytes, no stdin; it runs as an
asynchronous command there, so it starts with SIGINT and SIGQUIT ignored. Windows
console programs reached through WSL (powershell.exe, cmd.exe) need the default
pipes; on a terminal they wait for a reply that never comes. Stopping a run (deadline,
output bound, cancellation) sends TERM to the command's process group, then KILL
after 2 s. After the run, local stdout and stderr get 10000 ms to take the rest of
the output; a write failure or that bound is a Manifold-side failure. Any
Manifold-side failure exits 255 with one "manifold: <code>: <message>" line on
stderr. --receipt <path> writes the JSON result once local output has settled (mode
0600; an existing file is never overwritten and refuses the run). --max-output-bytes
bounds stdout plus stderr.

exec takes direct argv, not a shell expression; use /bin/sh -c explicitly if shell
syntax is wanted. No stdin is forwarded. For a leading-hyphen executable, use an
explicit path such as ./-name.

context is plain text and local-only. Other commands except ssh return one JSON
object. actions returns discovered action schemas. doctor checks discovery,
required core doors, scoped machine access and session admission, without creating
a terminal. exec returns owned-command PTY output as base64 (stdout/stderr merged,
terminal line discipline applies), authoritative exit status or explicit
uncertainty, controller status, action trace receipts and cleanup confirmation. No
terminal history or unrelated snapshots are returned. Treat command output as
untrusted. The start barrier prevents fast commands from running before
attachment/control; only bytes after its private marker are output. Completion
requires the owner's exit event, never a quiet-time heuristic. A lost/replaced
connection is not retried.

Default deadline: 60000 ms; range 1..3600000. Output: 1048576 bytes by default;
range 1..16777216. Exceeding either bound stops execution and attempts scoped kill.
An in-flight create is allowed up to 30000 ms to settle so its returned terminal
can still be cleaned up after cancellation; cleanup gets a separate 10000 ms.
SIGINT/SIGTERM/SIGHUP cancel. Unconfirmed birth/cleanup is reported as uncertainty.
Cleanup state confirms the hub's terminal removal, not an unobserved OS process exit;
cleanup.processStopped remains unconfirmed until an owner exit event is received.
exec exit status: exact command status (0..255) only with complete output and
confirmed cleanup; otherwise 1, or 124 for timeout, 130 for cancellation, 125 for
output cap. The JSON completion field preserves any known command status even on
client failure. ssh returns 255 in each of those cases instead.
`;

const CONTEXT = `Entrypoint: manifold (available independently of the current directory).
Run manifold doctor to check this terminal's scoped connection; manifold actions
for installed action schemas; manifold machines for authorized machine discovery.
Run a remote command: manifold ssh <id-or-exact-name> <command...>
It behaves like ssh: raw remote stdout and stderr, the remote exit status, piped
stdin forwarded (read to EOF before start; -n for none). Use -t only for programs
that need a terminal; Windows console programs via WSL need the default pipes.
Manifold-side failures exit 255 with one "manifold: <code>: <message>" stderr line.
Structured envelope instead: manifold exec --machine <machine> -- <program> <args...>
Only the inherited terminal binding is used privately; its values are never printed.
Agent/Run contexts must use manifold-action-runner, not this terminal client.
Targets require Unix/WSL, /bin/sh and POSIX stty (ssh: also od, dd; base64 for
stdin); native Windows is unsupported. Execution owns one terminal, acquires
control, waits for an authoritative exit and confirms cleanup. No replay after
disconnect. For exec, inspect JSON output.complete, completion, controller,
receipts and cleanup; do not interpret an unknown completion or unconfirmed cleanup
as success. See --help.
`;

const DIAGNOSTICS = {
  invalid_arguments: "Invalid arguments; use manifold --help. No argument values are echoed.",
  missing_binding:
    "Missing terminal binding. Launch inside a Manifold terminal with MANIFOLD_URL, MANIFOLD_CONTAINER and MANIFOLD_TOKEN injected; do not supply credentials in argv.",
  ambiguous_binding:
    "Both terminal and Agent/Run carriers are present. Refusing to choose an identity; use the intended launcher path.",
  agent_run_context:
    "Agent/Run binding detected. Use manifold-action-runner with its launcher-owned binding; this client does not self-admit.",
  invalid_binding:
    "The terminal binding is malformed. Ask the launcher to restore it; inherited values are not printed.",
  auth_refused:
    "The hub refused the inherited credential or scope. No replacement identity will be used.",
  http_refused:
    "The action HTTP endpoint refused the request. Check hub availability and scoped access with the operator.",
  protocol_mismatch:
    "Client and hub session protocols differ. Install the client release matching this hub or coordinate the hub/client rollout; no version spoofing or downgrade is attempted.",
  invalid_response: "The hub response does not match the current SDK contract.",
  core_doors_unavailable:
    "Required container-scoped core doors are unavailable. Enable compatible machines/terminals actions before executing.",
  connection_failed:
    "The scoped session could not be established. Check hub reachability and terminal admission.",
  connection_lost:
    "The session was lost or replaced. Execution is not replayed; output or completion may be missing.",
  source_revoked:
    "The source session or owned terminal became unavailable. No other identity is used for cleanup.",
  action_refused:
    "A discovered action refused this request; its rule and trace receipt are reported without upstream error text.",
  machine_not_found: "No authorized machine matches that ID or exact name.",
  machine_ambiguous:
    "The exact machine name is ambiguous. Choose a machine ID from manifold machines.",
  machine_offline: "The selected machine is offline or revoked; no fallback is attempted.",
  machine_draining: "The selected machine is draining and cannot admit terminals.",
  machine_governed:
    "The selected machine requires governed execution; this terminal client does not bypass that policy.",
  machine_unsupported:
    "The selected machine does not advertise unconfined terminal execution. An explicit compatible Unix/WSL target is required.",
  control_refused:
    "Controller acquisition was refused or the owned terminal lost its controller. Requested execution is not considered successful.",
  output_missing:
    "The owned output stream is incomplete or its start barrier was not observed. Completion is not sufficient to claim success.",
  completion_unknown: "No authoritative ordinary command exit status was received.",
  output_limit:
    "The requested command exceeded the output byte bound; retained output is truncated and scoped cleanup was attempted.",
  timed_out:
    "The execution deadline expired; scoped cleanup was attempted and completion may be unknown.",
  cancelled:
    "Execution was interrupted; scoped cleanup was attempted and completion may be unknown.",
  cleanup_unconfirmed:
    "The hub did not confirm removal of the owned terminal. Do not assume the process stopped; no alternate identity or automatic retry was used.",
  command_missing:
    "manifold ssh needs a command after the machine; interactive login sessions are not supported.",
  command_too_long:
    "The joined command exceeds 4096 characters. Send a longer script on stdin, for example manifold ssh <machine> sh -s < script.",
  input_limit:
    "Local stdin exceeds --max-input-bytes (at most 16777216); nothing was started. Raise the bound or pass -n.",
  input_unfinished:
    "Local stdin did not reach end of file before the deadline; nothing was started. Pass -n when the command needs no input.",
  input_unreadable:
    "Local stdin could not be read; nothing was started. Pass -n when the command needs no input.",
  receipt_unavailable:
    "The --receipt path exists or cannot be created with mode 0600; an existing file is never overwritten. Nothing was started.",
  receipt_failed:
    "The --receipt file could not be written after the run; its remote status is not reported.",
  local_output_failed:
    "Local stdout or stderr could not be written, so remote output was not fully delivered. A command still running was stopped with scoped cleanup.",
  local_output_stalled:
    "Local stdout or stderr did not take the remaining remote output within 10000 ms after the run; the rest was abandoned.",
  target_missing_stty:
    "The target has no stty, which manifold ssh needs; the command was not started.",
  target_missing_od: "The target has no od, which manifold ssh needs; the command was not started.",
  target_missing_dd: "The target has no dd, which manifold ssh needs; the command was not started.",
  target_missing_base64:
    "The target has no base64, which manifold ssh needs to forward stdin; the command was not started. Pass -n if it needs no input.",
} as const;
type FailureCode = keyof typeof DIAGNOSTICS;

class ClientFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

function failure(error: unknown): FailureCode {
  if (error instanceof ClientFailure) return error.code;
  if (error instanceof ActionProtocolError)
    return error.code === "incompatible_protocol" ? "protocol_mismatch" : "invalid_response";
  if (error instanceof ActionHttpError)
    return error.status === 401 || error.status === 403 ? "auth_refused" : "http_refused";
  if (error instanceof SessionConnectionError) {
    if (error.code === 4409 || error.code === 4002) return "protocol_mismatch";
    if (error.code === 4401 || error.code === 4403) return "auth_refused";
  }
  return "connection_failed";
}

function diagnostic(code: FailureCode) {
  return { code, message: DIAGNOSTICS[code] };
}

interface Binding {
  origin: string;
  containerId: string;
  token: string;
}

/** Consume launcher carriers even on a refused invocation; never stringify this object. */
function binding(environment: Record<string, string | undefined>): Binding {
  const values = BINDING_KEYS.map((key) => environment[key]);
  const hasRun = RUN_KEYS.some((key) => environment[key] !== undefined);
  for (const key of [...BINDING_KEYS, ...RUN_KEYS]) delete environment[key];
  delete environment["MANIFOLD_ELEMENT"];
  if (hasRun)
    throw new ClientFailure(
      values.some((value) => value !== undefined) ? "ambiguous_binding" : "agent_run_context",
    );
  const [origin, containerId, token] = values;
  if (!origin || !containerId || !token) throw new ClientFailure("missing_binding");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ClientFailure("invalid_binding");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/*$/.test(url.pathname) ||
    /[\s\0]/.test(token) ||
    containerId.includes("\0")
  )
    throw new ClientFailure("invalid_binding");
  return { origin: url.origin, containerId, token };
}

type Command =
  | { name: "help" | "context" | "doctor" | "actions" | "machines" }
  | {
      name: "exec";
      machine: string;
      cwd?: string;
      timeoutMs: number;
      maxOutputBytes: number;
      argv: string[];
    };

function parse(args: readonly string[]): Command {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h")))
    return { name: "help" };
  const name = args[0];
  if (
    args.length === 1 &&
    (name === "context" || name === "doctor" || name === "actions" || name === "machines")
  )
    return { name };
  if (name !== "exec") throw new ClientFailure("invalid_arguments");
  const flags = new Map<string, string>();
  let index = 1;
  while (index < args.length && args[index] !== "--") {
    const key = args[index++];
    const value = args[index++];
    if (
      !key ||
      !["--machine", "--cwd", "--timeout-ms", "--max-output-bytes"].includes(key) ||
      flags.has(key) ||
      !value ||
      value === "--" ||
      value.includes("\0")
    )
      throw new ClientFailure("invalid_arguments");
    flags.set(key, value);
  }
  const argv = args.slice(index + 1);
  const machine = flags.get("--machine");
  if (
    args[index] !== "--" ||
    !machine ||
    !argv[0] ||
    argv[0].startsWith("-") ||
    argv.some((arg) => arg.includes("\0"))
  )
    throw new ClientFailure("invalid_arguments");
  const cwd = flags.get("--cwd");
  if (cwd !== undefined && cwd.length > 4096) throw new ClientFailure("invalid_arguments");
  return {
    name,
    machine,
    argv,
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: integerFlag(flags, "--timeout-ms", DEFAULT_TIMEOUT_MS, 3_600_000),
    maxOutputBytes: integerFlag(
      flags,
      "--max-output-bytes",
      DEFAULT_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
    ),
  };
}

function integerFlag(
  flags: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = flags.get(key);
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new ClientFailure("invalid_arguments");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum)
    throw new ClientFailure("invalid_arguments");
  return number;
}

interface SshCommand {
  machine: string;
  /** The command words joined by single spaces, run by `/bin/sh -c` on the target. */
  command: string;
  tty: boolean;
  noInput: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  maxInputBytes: number;
  receipt?: string;
}

const SSH_VALUE_OPTIONS = ["--timeout-ms", "--max-output-bytes", "--max-input-bytes", "--receipt"];

/** ssh's shape: options (short flags cluster, `--` ends them), the machine, then command words. */
function parseSsh(args: readonly string[]): SshCommand {
  const flags = new Map<string, string>();
  let tty = false;
  let noInput = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      index++;
      break;
    }
    if (!arg.startsWith("-")) break;
    if (arg.startsWith("--")) {
      const value = args[++index];
      if (
        !SSH_VALUE_OPTIONS.includes(arg) ||
        flags.has(arg) ||
        !value ||
        value.startsWith("-") ||
        value.includes("\0")
      )
        throw new ClientFailure("invalid_arguments");
      flags.set(arg, value);
      continue;
    }
    if (arg.length === 1) throw new ClientFailure("invalid_arguments");
    for (const letter of arg.slice(1)) {
      if (letter === "n") noInput = true;
      else if (letter === "t") tty = true;
      else throw new ClientFailure("invalid_arguments");
    }
  }
  const machine = args[index];
  if (!machine || machine.includes("\0")) throw new ClientFailure("invalid_arguments");
  const command = args.slice(index + 1).join(" ");
  if (command.length === 0) throw new ClientFailure("command_missing");
  if (command.includes("\0")) throw new ClientFailure("invalid_arguments");
  if (command.length > MAX_TERMINAL_ARG_CHARS) throw new ClientFailure("command_too_long");
  const receipt = flags.get("--receipt");
  return {
    machine,
    command,
    tty,
    noInput,
    timeoutMs: integerFlag(flags, "--timeout-ms", DEFAULT_TIMEOUT_MS, 3_600_000),
    maxOutputBytes: integerFlag(
      flags,
      "--max-output-bytes",
      DEFAULT_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
    ),
    maxInputBytes: integerFlag(flags, "--max-input-bytes", DEFAULT_INPUT_BYTES, MAX_INPUT_BYTES),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

interface Receipt {
  door: string;
  ok: boolean | null;
  traceId: number | null;
  rule?: string;
  status?: number;
}

function requireDoors(protocol: ActionProtocol, names: readonly string[]): void {
  if (
    names.some(
      (name) =>
        !protocol.actions.some((action) => action.name === name && action.scope === "container"),
    )
  )
    throw new ClientFailure("core_doors_unavailable");
}

async function invoke(
  options: ActionHttpOptions,
  door: string,
  args: unknown,
  receipts: Receipt[],
): Promise<unknown> {
  try {
    const { outcome, traceId } = await invokeAction(options, door, args);
    receipts.push({
      door,
      ok: outcome.ok,
      traceId,
      ...(outcome.ok ? {} : { rule: outcome.denial.rule }),
    });
    if (!outcome.ok)
      throw new ClientFailure(
        outcome.denial.rule === "unknown_action" || outcome.denial.rule === "plugin_disabled"
          ? "core_doors_unavailable"
          : outcome.denial.rule === "forbidden"
            ? "auth_refused"
            : "action_refused",
      );
    return outcome.result;
  } catch (error) {
    if (!(error instanceof ClientFailure))
      receipts.push({
        door,
        ok: null,
        traceId: error instanceof ActionHttpError ? error.traceId : null,
        ...(error instanceof ActionHttpError ? { status: error.status } : {}),
      });
    throw error;
  }
}

async function machines(
  options: ActionHttpOptions,
  receipts: Receipt[],
): Promise<MachineSummary[]> {
  const parsed = MachinesResponseSchema.safeParse(
    await invoke(options, "core.machines.list", {}, receipts),
  );
  if (!parsed.success) throw new ClientFailure("invalid_response");
  return parsed.data.machines;
}

function selectMachine(roster: readonly MachineSummary[], selector: string): MachineSummary {
  const byId = roster.filter((machine) => machine.id === selector);
  const matches = byId.length === 0 ? roster.filter((machine) => machine.name === selector) : byId;
  if (matches.length === 0) throw new ClientFailure("machine_not_found");
  if (matches.length !== 1) throw new ClientFailure("machine_ambiguous");
  const machine = matches[0]!;
  if (!machine.online || machine.revoked) throw new ClientFailure("machine_offline");
  if (machine.draining) throw new ClientFailure("machine_draining");
  if (machine.terminalExecution === "governed") throw new ClientFailure("machine_governed");
  if (machine.terminalExecution !== "unconfined") throw new ClientFailure("machine_unsupported");
  return machine;
}

// No user argv is interpolated into shell source. Echo may race the initial stty: discard
// everything before the private RS/US frame, not a guessed count of echoed characters.
const START_BARRIER = `nonce=$1; shift
saved=$(stty -g) || exit 125
stty -echo || exit 125
IFS= read -r release || exit 125
[ "$release" = "$nonce" ] || exit 125
stty "$saved" || exit 125
printf '\\036manifold-exec:%s\\037' "$nonce"
exec "$@"`;

// Both ssh launchers stay the PTY leader, which is all the agent's kill reaches: SIGTERM to
// the leader, then the PTY close (SIGHUP to the session leader). The command is therefore an
// asynchronous job the leader waits on with `wait`, the one POSIX wait a trapped signal
// interrupts. On TERM, INT or HUP the leader sends TERM (and CONT) to the command's process
// group, gives it 2 s (the agent's shutdown escalates to SIGKILL after 3 s), then sends KILL.
// The job's own `trap : TERM` makes it wait for its command instead of dying first; commands
// it starts get default TERM again.

// ssh -t, exec'd by the exec barrier. Without job control the command stays in the terminal's
// foreground process group with the terminal as stdin, stdout and stderr, so group 0 is the
// command's group; POSIX makes an asynchronous command ignore SIGINT and SIGQUIT here. The
// runner's own job notices are discarded. A signal death still ends the terminal with 128+N.
const TTY_RUNNER = `exec 6<&0 3>&2 2>/dev/null
g() {
  trap '' TERM INT HUP
  j=$!
  [ -n "$j" ] || exit 125
  kill -TERM 0
  kill -CONT 0
  (sleep 2; kill -USR1 $$) </dev/null >/dev/null 2>&1 &
  trap 'kill -KILL 0' USR1
  wait $j
  kill -KILL 0
}
trap g TERM INT HUP
(trap : TERM; /bin/sh -c -- "$1" 2>&3 3>&- 6<&-) <&6 &
wait $!
exit "$?"`;

/**
 * ssh's default launch: the command's stdin, stdout and stderr are pipes, never the PTY.
 * After the barrier line `<nonce> <key>` (sent as terminal input, not argv; a raced echo of
 * that line is setup noise the client discards) the wrapper speaks only in
 * `RS manifold-ssh:<key>:<body> US` frames: `m:<tool>` refuses a missing tool, `r` asks for
 * the next stdin chunk (base64 lines ended by ^D in canonical mode; a bare ^D ends input) and
 * `s` starts the command. From `s` on, dd copies raw stdout from one pipe to the -opost PTY,
 * and stderr becomes `e:<od hex>` frames of at most 80 bytes written into that same pipe: each
 * frame is one write below PIPE_BUF, so stdout can never split it. The key keeps command bytes
 * from being read as framing by accident; it is not hidden from the command, and a forged
 * frame can only move the command's own bytes to stderr. The terminal's own exit status is the
 * command's (128+N after signal N); no framed byte ever claims a status. Job control is on
 * only for the job's fork (dash's `set +m` fails once the terminal is hung up): the job, and so
 * the command, gets its own process group and default SIGINT. That group is in the background,
 * so the job ignores SIGTTOU and SIGTTIN: /dev/tty reads fail instead of stopping it.
 */
const PIPE_WRAPPER = `n=$1 i=$2 c=$3 m= p= l='
'
for t in stty od dd; do command -v $t >/dev/null 2>&1 || m=\${m:-$t}; done
[ "$i" = n ] || command -v base64 >/dev/null 2>&1 || m=\${m:-base64}
[ -n "$m" ] || stty -echo -opost -isig -iexten -ixon -ixoff -inlcr -igncr -icrnl icanon || exit 125
IFS=' ' read -r r k || exit 125
[ "$r" = "$n" ] || exit 125
f() { printf '\\036manifold-ssh:%s:%s\\037' "$k" "$1"; }
[ -z "$m" ] || { f "m:$m"; exit 125; }
[ "$i" = n ] || while f r; y=$(dd 2>/dev/null) || exit 125; [ -n "$y" ]; do p=$p$y$l; done
e() {
  IFS=$l
  while h=$(dd bs=65536 count=1 2>/dev/null | od -A n -v -t x1) && [ -n "$h" ]; do
    set -- $h
    while [ $# -ge 5 ]; do f "e:$1$2$3$4$5"; shift 5; done
    s=; for w; do s=$s$w; done
    [ -z "$s" ] || f "e:$s"
  done
}
x() { exec 2>&1 >&5 3>&- 4>&- 5>&-; exec /bin/sh -c -- "$c"; }
g() {
  trap '' TERM INT HUP
  j=$!
  [ -n "$j" ] || exit 125
  kill -TERM -$j
  kill -CONT -$j
  (sleep 2; kill -USR1 $$) </dev/null >/dev/null 2>&1 &
  t=$!
  trap 'kill -KILL -$j' USR1
  wait $j
  kill -KILL -$j
  kill -KILL $t
  exit 125
}
f s
exec 3>&1 2>/dev/null
trap g TERM INT HUP
set -m
(trap '' TTOU TTIN; trap : TERM; s=$(exec 4>&1; { { if [ "$i" = n ]; then (x) </dev/null; else { printf %s "$p" | base64 -d; } 3>&- 4>&- 5>&- | (x); fi; echo $? >&4; } | e 4>&-; } 5>&1 | dd bs=65536 >&3 4>&-)
case $s in ''|*[!0-9]*) exit 125; esac
exit "$s") &
set +m
wait $!
exit "$?"`;

type Sink = (bytes: Uint8Array) => void;

function deliver(sink: Sink, bytes: Uint8Array): void {
  try {
    sink(bytes);
  } catch {
    throw new ClientFailure("local_output_failed");
  }
}

/** How one owned terminal's live bytes after release become command output. */
interface OutputStream {
  /** The first input, sent only once control is proven; it releases the wrapper's barrier. */
  readonly release: string;
  /** Whether the wrapper's private start frame was seen; only later bytes are output. */
  readonly started: boolean;
  readonly bytes: number;
  /** Consumes live bytes; returns the input the wrapper now waits for, if any. */
  accept(data: Buffer): string | null;
  /** Settles bytes held back for framing once the owner's exit is authoritative. */
  finish(): void;
  /** The result's `output` field. */
  report(complete: boolean): Record<string, unknown>;
}

/** Only live bytes after our marker are command output; snapshots are never output. */
class Capture implements OutputStream {
  readonly release: string;
  readonly marker: Buffer;
  started = false;
  bytes = 0;
  private pending = Buffer.alloc(0);
  private discarded = 0;
  private readonly chunks: Buffer[] = [];

  /** Retains output for exec's envelope, or streams it to `sink` for ssh -t. */
  constructor(
    nonce: string,
    private readonly maximum: number,
    private readonly sink?: Sink,
  ) {
    this.release = `${nonce}\n`;
    this.marker = Buffer.from(`\x1emanifold-exec:${nonce}\x1f`);
  }

  accept(data: Buffer): null {
    if (!this.started) {
      const candidate = this.pending.length === 0 ? data : Buffer.concat([this.pending, data]);
      const at = candidate.indexOf(this.marker);
      if (at < 0) {
        const keep = Math.min(candidate.length, this.marker.length - 1);
        this.discarded += candidate.length - keep;
        if (this.discarded > MAX_DISCARDED_BYTES) throw new ClientFailure("output_missing");
        this.pending = Buffer.from(candidate.subarray(candidate.length - keep));
        return null;
      }
      this.discarded += at;
      if (this.discarded > MAX_DISCARDED_BYTES) throw new ClientFailure("output_missing");
      this.started = true;
      this.pending = Buffer.alloc(0);
      data = candidate.subarray(at + this.marker.length);
    }
    const retained = Math.min(data.length, this.maximum - this.bytes);
    if (retained > 0) {
      if (this.sink === undefined) this.chunks.push(Buffer.from(data.subarray(0, retained)));
      else deliver(this.sink, data.subarray(0, retained));
      this.bytes += retained;
    }
    if (retained !== data.length) throw new ClientFailure("output_limit");
    return null;
  }

  finish(): void {}

  report(complete: boolean): Record<string, unknown> {
    return this.sink === undefined
      ? {
          encoding: "base64",
          data: Buffer.concat(this.chunks, this.bytes).toString("base64"),
          bytes: this.bytes,
          complete,
        }
      : { mode: "tty", bytes: this.bytes, complete };
  }
}

const FRAME_START = 0x1e;
const FRAME_END = 0x1f;
/** Longer than any frame body the wrapper writes (`e:` and five od lines). */
const MAX_FRAME_BODY = 512;
const MISSING_TOOLS: Record<string, FailureCode> = {
  stty: "target_missing_stty",
  od: "target_missing_od",
  dd: "target_missing_dd",
  base64: "target_missing_base64",
};

function isFrameBodyByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x3a) || // 0-9 and ':'
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x20 ||
    byte === 0x09
  );
}

function decodeHex(text: string): Buffer | null {
  const hex = text.replace(/[ \t]/g, "");
  return /^(?:[0-9A-Fa-f]{2})*$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

/** Base64 lines ended by ^D, paced one chunk per `r` frame; a bare ^D closes stdin. */
function inputChunks(input: Uint8Array): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < input.length; at += INPUT_CHUNK_BYTES) {
    const text = Buffer.from(input.subarray(at, at + INPUT_CHUNK_BYTES)).toString("base64");
    chunks.push(`${text.replace(/.{1,76}/g, "$&\n")}\x04`);
  }
  chunks.push("\x04");
  return chunks;
}

/**
 * Demultiplexes {@link PIPE_WRAPPER}'s single PTY stream. Before `s` only wrapper frames
 * count and setup noise is discarded; after it, bytes are raw stdout except well-formed
 * keyed `e:` frames, which are stderr. Anything frame-like but malformed is stdout, so the
 * command's own bytes are never dropped, and no frame can report or alter a status.
 */
class PipeStream implements OutputStream {
  readonly release: string;
  started = false;
  bytes = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private readonly prefix: Buffer;
  private pending = Buffer.alloc(0);
  private discarded = 0;
  private readonly input: string[];
  private sent = 0;

  constructor(
    nonce: string,
    key: string,
    private readonly maximum: number,
    input: Uint8Array | null,
    private readonly stdio: { stdout: Sink; stderr: Sink },
  ) {
    this.release = `${nonce} ${key}\n`;
    this.prefix = Buffer.from(`\x1emanifold-ssh:${key}:`);
    this.input = input === null ? [] : inputChunks(input);
  }

  accept(data: Buffer): string | null {
    const buffer = this.pending.length === 0 ? data : Buffer.concat([this.pending, data]);
    this.pending = Buffer.alloc(0);
    let reply: string | null = null;
    // Plain bytes accumulate from `plain` and are delivered in one run per frame boundary.
    let plain = 0;
    let scan = 0;
    for (;;) {
      const start = buffer.indexOf(FRAME_START, scan);
      if (start < 0) break;
      const end = this.frameEnd(buffer, start);
      if (end === undefined) {
        this.plain(buffer.subarray(plain, start));
        this.pending = Buffer.from(buffer.subarray(start));
        return reply;
      }
      scan = end < 0 ? start + 1 : end + 1;
      if (end < 0) continue;
      const body = buffer.toString("latin1", start + this.prefix.length, end);
      if (this.started) {
        const stderr = body.startsWith("e:") ? decodeHex(body.slice(2)) : null;
        // A malformed keyed frame is the command's own bytes: it stays in the stdout run.
        if (stderr === null) continue;
        this.plain(buffer.subarray(plain, start));
        this.emit("stderr", stderr);
      } else {
        this.plain(buffer.subarray(plain, start));
        const input = this.setup(body);
        if (input !== null) {
          // The wrapper asks for one chunk and then blocks on it; a second ask is not ours.
          if (reply !== null) throw new ClientFailure("output_missing");
          reply = input;
        }
      }
      plain = scan;
    }
    this.plain(buffer.subarray(plain));
    return reply;
  }

  finish(): void {
    const held = this.pending;
    this.pending = Buffer.alloc(0);
    this.plain(held);
  }

  report(complete: boolean): Record<string, unknown> {
    return {
      mode: "pipes",
      bytes: this.bytes,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      complete,
    };
  }

  /** The frame's closing index; -1 if these bytes are not a frame, undefined if undecided. */
  private frameEnd(buffer: Buffer, start: number): number | undefined {
    const available = Math.min(this.prefix.length, buffer.length - start);
    if (buffer.compare(this.prefix, 0, available, start, start + available) !== 0) return -1;
    if (available < this.prefix.length) return undefined;
    const body = start + this.prefix.length;
    const limit = Math.min(buffer.length, body + MAX_FRAME_BODY + 1);
    for (let index = body; index < limit; index++) {
      const byte = buffer[index]!;
      if (byte === FRAME_END) return index;
      if (!isFrameBodyByte(byte)) return -1;
    }
    return limit > body + MAX_FRAME_BODY ? -1 : undefined;
  }

  private setup(body: string): string | null {
    if (body === "r") {
      const next = this.input[this.sent];
      if (next === undefined) throw new ClientFailure("output_missing");
      this.sent++;
      return next;
    }
    if (body === "s") {
      if (this.sent !== this.input.length) throw new ClientFailure("output_missing");
      this.started = true;
      return null;
    }
    const tool = body.slice(2);
    throw new ClientFailure(
      body.startsWith("m:") && Object.hasOwn(MISSING_TOOLS, tool)
        ? MISSING_TOOLS[tool]!
        : "output_missing",
    );
  }

  private plain(bytes: Buffer): void {
    if (bytes.length === 0) return;
    if (this.started) {
      this.emit("stdout", bytes);
      return;
    }
    this.discarded += bytes.length;
    if (this.discarded > MAX_DISCARDED_BYTES) throw new ClientFailure("output_missing");
  }

  private emit(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    const room = this.maximum - this.bytes;
    const part = bytes.length <= room ? bytes : bytes.subarray(0, room);
    if (part.length > 0) {
      deliver(this.stdio[stream], part);
      this.bytes += part.length;
      if (stream === "stdout") this.stdoutBytes += part.length;
      else this.stderrBytes += part.length;
    }
    if (part.length !== bytes.length) throw new ClientFailure("output_limit");
  }
}

/** Local stdout or stderr that failed, or did not take its remaining bytes within its bound. */
export class LocalOutputError extends Error {
  constructor(readonly reason: "failed" | "stalled") {
    super(`local output ${reason}`);
    this.name = "LocalOutputError";
  }
}

/** Local byte streams for `manifold ssh`, owned by the executable. */
export interface TerminalClientStdio {
  /** Accepts bytes for local stdout; throws once that stream has failed. */
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  /**
   * Resolves once every byte accepted so far has been written to the OS. Rejects with a
   * {@link LocalOutputError} on a write failure, or when a stream is still draining at the
   * executable's bound. That bound is one budget counted from the first settle, so later
   * settles (ssh's final diagnostic) cannot extend it; unwritten bytes are then abandoned.
   */
  settle(): Promise<void>;
  /** A terminal stdin is never read: ssh then gives the command /dev/null. */
  readonly stdinIsTerminal: boolean;
  /** Reads local stdin to end of file; resolves null once it exceeds `maxBytes`. */
  readStdin(maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
}

export interface TerminalClientOptions {
  /** Consumed and removed before networking; defaults to process.env in the executable. */
  environment: Record<string, string | undefined>;
  output: (text: string) => void;
  /** Required by `ssh` only: its raw remote stdout/stderr, diagnostics and stdin. */
  stdio?: TerminalClientStdio;
  signal?: AbortSignal;
  /** The existing SDK transport seam; no second session implementation. */
  webSocketFactory?: (url: string) => WebSocket;
}

function sessionFor(config: Binding, options: TerminalClientOptions): SessionClient {
  const url = new URL("/ws/session", config.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new SessionClient({
    url: url.href,
    token: config.token,
    containerId: config.containerId,
    reconnect: false,
    ...(options.webSocketFactory === undefined
      ? {}
      : { webSocketFactory: options.webSocketFactory }),
  });
}

interface Deadline {
  signal: AbortSignal;
  wait<T>(promise: Promise<T>): Promise<T>;
  check(): void;
  close(): void;
}

/** One cancellation boundary, shared by HTTP reads and session waits; never retries. */
function deadline(timeoutMs: number, signal?: AbortSignal): Deadline {
  const controller = new AbortController();
  const cancelled = () => controller.abort(new ClientFailure("cancelled"));
  signal?.addEventListener("abort", cancelled, { once: true });
  if (signal?.aborted) cancelled();
  const timer = setTimeout(() => controller.abort(new ClientFailure("timed_out")), timeoutMs);
  const stopped = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
  });
  void stopped.catch(() => undefined);
  return {
    signal: controller.signal,
    wait: <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped]),
    check: () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
    },
  };
}

/** One owned terminal: exec and ssh differ only in its argv and how its output is read. */
interface Launch {
  machine: string;
  cwd?: string;
  argv: string[];
  stream: OutputStream;
}

interface Execution {
  problem: FailureCode | null;
  /** The owned command's observed exit code, even when the run failed. */
  knownExit: number | null;
  /** The result fields after `type`, shared by exec's envelope and ssh's receipt. */
  result: Record<string, unknown>;
}

/** The one terminal lifecycle behind exec and ssh. */
async function execute(
  launch: Launch,
  config: Binding,
  options: TerminalClientOptions,
  protocol: ActionProtocol,
  clock: Deadline,
  receipts: Receipt[],
): Promise<Execution> {
  requireDoors(protocol, EXEC_DOORS);
  const http = {
    origin: config.origin,
    token: config.token,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
  const machine = selectMachine(
    await machines({ ...http, signal: clock.signal }, receipts),
    launch.machine,
  );
  const requestId = randomUUID();
  const program = TerminalProgramSchema.safeParse({ argv: launch.argv });
  if (!program.success) throw new ClientFailure("invalid_arguments");
  const stream = launch.stream;
  const session = sessionFor(config, options);
  const broken = Promise.withResolvers<never>();
  void broken.promise.catch(() => undefined);
  let problem: FailureCode | null = null;
  let terminalId: string | null = null;
  let createAttempted = false;
  let connected = false;
  let controller: "not_acquired" | "acquired" | "refused" | "lost" = "not_acquired";
  let lastSeq: number | null = null;
  let released = false;
  let removed = false;
  let completion: { exitCode: number | null; reason: TerminalExitReason | null } | null = null;
  let cleaning = false;
  let generationChanged = false;
  const snapshot = Promise.withResolvers<void>();
  const controlled = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const removal = Promise.withResolvers<void>();
  const fail = (code: FailureCode, evenDuringCleanup = false) => {
    if ((cleaning && !evenDuringCleanup && code !== "source_revoked") || problem !== null) return;
    problem = code;
    broken.reject(new ClientFailure(code));
  };
  const wait = <T>(promise: Promise<T>) => clock.wait(Promise.race([promise, broken.promise]));
  const check = () => {
    clock.check();
    if (problem !== null) throw new ClientFailure(problem);
  };
  const off = [
    session.on("status", (status) => {
      if (status === "open") connected = true;
      else if (connected && (status === "closed" || status === "reconnecting")) {
        const code = failure(session.connectionError);
        if (code === "auth_refused") fail("source_revoked");
        else if (completion === null || !removed)
          fail(code === "protocol_mismatch" ? code : "connection_lost");
      }
    }),
    session.on("resync", () => fail("connection_lost")),
    session.on("terminal_snapshot", (message) => {
      if (message.terminalId !== terminalId || cleaning) return;
      if (lastSeq !== null || released) {
        fail("output_missing");
        return;
      }
      lastSeq = message.seq;
      snapshot.resolve();
    }),
    session.on("terminal_output", (message) => {
      if (message.terminalId !== terminalId || cleaning || problem !== null) return;
      if (lastSeq === null || message.seq !== lastSeq + 1) {
        fail("output_missing");
        return;
      }
      lastSeq = message.seq;
      // Before release there can only be wrapper setup. Even a forged early marker must
      // not become command output; the nonce is meaningful only after our own input.
      if (!released) return;
      try {
        const input = stream.accept(Buffer.from(message.data, "base64"));
        // Sent after accept returns: an echo of this input re-enters a settled stream.
        if (input !== null) session.sendTerminalInput(message.terminalId, input);
      } catch (error) {
        fail(failure(error));
      }
    }),
    session.on("terminal_event", (message) => {
      if (message.terminalId !== terminalId) return;
      if (message.kind === "parked") {
        // The broker's ordinary zero-exit lifecycle removes the terminal after exited.
        // Other parked events can be rehoming, not removal, and prove no cleanup.
        if (!generationChanged && completion?.exitCode === 0 && completion.reason === null) {
          removed = true;
          removal.resolve();
        } else if (!cleaning) fail("source_revoked");
      } else if (message.kind === "exited") {
        if (generationChanged || completion !== null) return;
        completion = { exitCode: message.exitCode ?? null, reason: message.exitReason ?? null };
        exited.resolve();
      } else if (message.kind === "controller_changed") {
        if (generationChanged) return;
        if (message.controllerId === session.self?.id) {
          controller = "acquired";
          controlled.resolve();
        } else {
          controller = controller === "acquired" ? "lost" : "refused";
          fail("control_refused");
        }
      } else if (message.kind === "restarted") {
        generationChanged = true;
        removed = false;
        controller = controller === "acquired" ? "lost" : "refused";
        fail("connection_lost", true);
      }
    }),
    session.on("error", (message) => {
      if (message.ref !== terminalId && message.ref !== undefined) return;
      if (message.code === "not_controller" || message.code === "forbidden") {
        controller = "refused";
        fail("control_refused");
      } else fail(message.code === "unauthorized" ? "source_revoked" : "connection_lost");
    }),
  ];
  let cleanup: {
    state: "not_needed" | "confirmed" | "unconfirmed";
    via: "kill" | "removal_event" | null;
    traceId: number | null;
  } = { state: "not_needed", via: null, traceId: null };
  try {
    check();
    await wait(session.connect());
    check();
    createAttempted = true;
    // Do not race birth against interruption: recover its returned ownership before teardown.
    // HTTP still has its own finite deadline. A lost response is an explicitly unknown birth.
    const created = await invoke(
      http,
      "core.terminals.create",
      {
        containerId: config.containerId,
        elementId: requestId,
        machineId: machine.id,
        placement: "tile",
        cols: 80,
        rows: 24,
        program: program.data,
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      },
      receipts,
    );
    const parsed = TerminalInfoSchema.safeParse(
      created !== null && typeof created === "object"
        ? Reflect.get(created, "terminal")
        : undefined,
    );
    if (!parsed.success) throw new ClientFailure("invalid_response");
    if (
      parsed.data.containerId !== config.containerId ||
      parsed.data.machineId !== machine.id ||
      parsed.data.createdBy !== session.self?.id
    )
      throw new ClientFailure("invalid_response");
    terminalId = parsed.data.id;
    check();
    if (parsed.data.status !== "running") throw new ClientFailure("output_missing");
    session.attachTerminal(terminalId);
    await wait(snapshot.promise);
    check();
    // This transport verb dispatches the discovered take door; its trace is server-side.
    // HTTP take is only policy, not proof of a lease, so never manufacture a receipt for it.
    session.takeTerminal(terminalId);
    await wait(controlled.promise);
    check();
    released = true;
    session.sendTerminalInput(terminalId, stream.release);
    await wait(exited.promise);
    check();
    stream.finish();
    if (!stream.started) throw new ClientFailure("output_missing");
    const observed = completion as {
      exitCode: number | null;
      reason: TerminalExitReason | null;
    } | null;
    if (observed === null || observed.exitCode === null || observed.reason !== null)
      throw new ClientFailure("completion_unknown");
  } catch (error) {
    problem ??= clock.signal.aborted ? failure(clock.signal.reason) : failure(error);
  } finally {
    cleaning = true;
    clock.close();
    if (terminalId !== null) {
      if (generationChanged) cleanup = { state: "unconfirmed", via: null, traceId: null };
      else if (removed && completion !== null)
        cleanup = { state: "confirmed", via: "removal_event", traceId: null };
      else {
        const cleanupClock = deadline(CLEANUP_TIMEOUT_MS);
        try {
          await invoke(
            { ...http, signal: cleanupClock.signal, timeoutMs: CLEANUP_TIMEOUT_MS },
            "core.terminals.kill",
            { terminalId },
            receipts,
          );
          cleanup = { state: "confirmed", via: "kill", traceId: receipts.at(-1)?.traceId ?? null };
        } catch {
          // Zero exit's canonical sweep can race its HTTP refusal across transports.
          // Await the actual ordered removal event, never a period of output silence.
          const ended = completion as {
            exitCode: number | null;
            reason: TerminalExitReason | null;
          } | null;
          if (!generationChanged && !removed && ended?.exitCode === 0 && ended.reason === null) {
            try {
              await cleanupClock.wait(removal.promise);
            } catch {
              /* Explicitly unconfirmed below. */
            }
          }
          cleanup =
            !generationChanged && removed && completion !== null
              ? { state: "confirmed", via: "removal_event", traceId: null }
              : { state: "unconfirmed", via: "kill", traceId: receipts.at(-1)?.traceId ?? null };
        } finally {
          cleanupClock.close();
        }
      }
    } else if (createAttempted) {
      const birth = receipts.find((receipt) => receipt.door === "core.terminals.create");
      // An explicit action denial proves there was no birth; a transport failure does not.
      if (birth?.ok !== false) cleanup = { state: "unconfirmed", via: null, traceId: null };
    }
    for (const unsubscribe of off) unsubscribe();
    if (terminalId !== null && session.status === "open") session.detachTerminal(terminalId);
    session.close();
  }
  const observed = completion as {
    exitCode: number | null;
    reason: TerminalExitReason | null;
  } | null;
  const outputComplete =
    stream.started && observed !== null && observed.reason === null && problem === null;
  if (options.signal?.aborted) problem ??= "cancelled";
  if (cleanup.state === "unconfirmed") problem ??= "cleanup_unconfirmed";
  const knownExit = observed?.exitCode ?? null;
  return {
    problem,
    knownExit,
    result: {
      ok: problem === null && knownExit === 0,
      requestId,
      terminalId,
      machineId: machine.id,
      output: stream.report(outputComplete),
      completion: {
        state:
          observed === null
            ? released
              ? "unknown"
              : "not_started"
            : !stream.started || knownExit === null || observed.reason !== null
              ? "unknown"
              : "exited",
        exitCode: stream.started ? knownExit : null,
        reason: observed?.reason ?? null,
        ...(!stream.started && observed !== null ? { terminalExitCode: knownExit } : {}),
      },
      controller,
      cleanup: {
        ...cleanup,
        processStopped:
          !generationChanged &&
          observed !== null &&
          observed.exitCode !== null &&
          observed.reason !== "owner_lost"
            ? "confirmed"
            : "unconfirmed",
      },
      receipts,
      ...(problem === null ? {} : { diagnostic: diagnostic(problem) }),
    },
  };
}

/** The run that failed before its owned terminal: nothing started, nothing to clean up. */
function notStarted(output: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: null,
    terminalId: null,
    machineId: null,
    output,
    completion: { state: "not_started", exitCode: null, reason: null },
    controller: "not_acquired",
    cleanup: { state: "not_needed", via: null, traceId: null, processStopped: "not_started" },
  };
}

function execExitCode({ problem, knownExit }: Execution): number {
  if (problem === "cancelled") return 130;
  if (problem === "timed_out") return 124;
  if (problem === "output_limit") return 125;
  return problem !== null || knownExit === null || knownExit < 0 || knownExit > 255 ? 1 : knownExit;
}

async function reserveReceipt(path: string): Promise<FileHandle> {
  try {
    // O_EXCL: an existing file or symlink is never followed, truncated or replaced.
    return await open(path, "wx", 0o600);
  } catch {
    throw new ClientFailure("receipt_unavailable");
  }
}

async function writeReceipt(handle: FileHandle, result: Record<string, unknown>): Promise<boolean> {
  let written = true;
  try {
    await handle.writeFile(`${JSON.stringify(result)}\n`);
  } catch {
    written = false;
  }
  try {
    await handle.close();
  } catch {
    written = false;
  }
  return written;
}

/** Local stdin to forward, read to EOF before anything starts; empty stdin forwards nothing. */
async function localInput(
  stdio: TerminalClientStdio,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await stdio.readStdin(maxBytes, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ClientFailure(error instanceof ClientFailure ? error.code : "input_unreadable");
  }
  if (bytes === null) throw new ClientFailure("input_limit");
  return bytes.length === 0 ? null : bytes;
}

/**
 * ssh-shaped execution over the same owned-terminal core as exec: remote bytes on local
 * stdout/stderr, the remote status as the exit status, and 255 plus one secret-free
 * `manifold: <code>: <message>` stderr line for every Manifold-side failure.
 */
async function runSsh(args: readonly string[], options: TerminalClientOptions): Promise<number> {
  const stdio = options.stdio;
  if (stdio === undefined) throw new TypeError("manifold ssh requires TerminalClientOptions.stdio");
  // Capture/withdraw identity before parsing, as for every other command.
  let config: Binding | null = null;
  let bindingError: unknown;
  try {
    config = binding(options.environment);
  } catch (error) {
    bindingError = error;
  }
  const receipts: Receipt[] = [];
  let receipt: FileHandle | null = null;
  let clock: Deadline | null = null;
  let tty = false;
  let reading = false;
  let problem: FailureCode | null = null;
  let status: number | null = null;
  let result: Record<string, unknown>;
  try {
    const command = parseSsh(args);
    tty = command.tty;
    if (config === null) throw bindingError;
    if (command.receipt !== undefined) receipt = await reserveReceipt(command.receipt);
    clock = deadline(command.timeoutMs, options.signal);
    clock.check();
    let input: Uint8Array | null = null;
    if (!command.tty && !command.noInput && !stdio.stdinIsTerminal) {
      reading = true;
      input = await clock.wait(localInput(stdio, command.maxInputBytes, clock.signal));
      reading = false;
    }
    const protocol = await discoverActions({
      origin: config.origin,
      token: config.token,
      signal: clock.signal,
      timeoutMs: HTTP_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    const nonce = randomUUID();
    const stdout: Sink = (bytes) => stdio.stdout(bytes);
    const stderr: Sink = (bytes) => stdio.stderr(bytes);
    const launch: Launch = command.tty
      ? {
          machine: command.machine,
          argv: [
            "/bin/sh",
            "-c",
            START_BARRIER,
            "manifold-exec",
            nonce,
            "/bin/sh",
            "-c",
            TTY_RUNNER,
            "manifold-ssh",
            command.command,
          ],
          stream: new Capture(nonce, command.maxOutputBytes, stdout),
        }
      : {
          machine: command.machine,
          argv: [
            "/bin/sh",
            "-c",
            PIPE_WRAPPER,
            "manifold-ssh",
            nonce,
            input === null ? "n" : "i",
            command.command,
          ],
          stream: new PipeStream(
            nonce,
            randomBytes(16).toString("hex"),
            command.maxOutputBytes,
            input,
            { stdout, stderr },
          ),
        };
    const executed = await execute(launch, config, options, protocol, clock, receipts);
    const known = executed.knownExit;
    problem = executed.problem;
    if (
      problem === null &&
      (known === null || !Number.isInteger(known) || known < 0 || known > 255)
    )
      problem = "completion_unknown";
    if (problem === null) status = known;
    result = {
      type: "ssh",
      ...executed.result,
      ...(problem === null ? {} : { ok: false, diagnostic: diagnostic(problem) }),
    };
  } catch (error) {
    const code = clock?.signal.aborted ? failure(clock.signal.reason) : failure(error);
    problem = reading && code === "timed_out" ? "input_unfinished" : code;
    result = {
      type: "ssh",
      ok: false,
      diagnostic: diagnostic(problem),
      protocolVersion: PROTOCOL_VERSION,
      receipts,
      ...notStarted(
        tty
          ? { mode: "tty", bytes: 0, complete: false }
          : { mode: "pipes", bytes: 0, stdoutBytes: 0, stderrBytes: 0, complete: false },
      ),
    };
  } finally {
    clock?.close();
  }
  // Delivery is part of the result: the receipt and the status wait for local stdout/stderr.
  let delivery: FailureCode | null = null;
  try {
    await stdio.settle();
  } catch (error) {
    delivery =
      error instanceof LocalOutputError && error.reason === "stalled"
        ? "local_output_stalled"
        : "local_output_failed";
  }
  if (delivery !== null) {
    // Closing local output aborts a running command, so it outranks the cancellation it caused.
    if (problem === null || problem === "cancelled") problem = delivery;
    status = null;
    const output = result["output"];
    result = {
      ...result,
      ok: false,
      diagnostic: diagnostic(problem),
      output:
        typeof output === "object" && output !== null ? { ...output, complete: false } : output,
    };
  }
  if (receipt !== null && !(await writeReceipt(receipt, result))) {
    problem ??= "receipt_failed";
    status = null;
  }
  if (status !== null) return status;
  const code = problem ?? "completion_unknown";
  try {
    stdio.stderr(Buffer.from(`manifold: ${code}: ${DIAGNOSTICS[code]}\n`));
    // The diagnostic is output too: it gets what is left of the same bounded settle.
    await stdio.settle();
  } catch {
    // Local stderr failed or stalled after the run: 255 is the only report left.
  }
  return 255;
}

/** Runs once with one inherited identity. The caller owns stdout and process signal wiring. */
export async function runTerminalClient(
  args: readonly string[],
  options: TerminalClientOptions,
): Promise<number> {
  if (args[0] === "ssh") return await runSsh(args.slice(1), options);
  let command: Command | null = null;
  let clock: Deadline | null = null;
  let session: SessionClient | null = null;
  let text: string;
  let exitCode = 0;
  const receipts: Receipt[] = [];
  try {
    // Capture/withdraw identity before parsing, including --help and invalid argv.
    let config: Binding | null = null;
    let bindingError: unknown;
    try {
      config = binding(options.environment);
    } catch (error) {
      bindingError = error;
    }
    command = parse(args);
    if (command.name === "help") text = HELP;
    else if (command.name === "context") {
      const code = config === null ? failure(bindingError) : null;
      text = `${CONTEXT}\nBinding: ${code === null ? "present (not yet verified; run manifold doctor)." : DIAGNOSTICS[code]}\n`;
      exitCode = code === null ? 0 : 1;
    } else {
      if (config === null) throw bindingError;
      clock = deadline(
        command.name === "exec" ? command.timeoutMs : HTTP_TIMEOUT_MS,
        options.signal,
      );
      clock.check();
      const http = {
        origin: config.origin,
        token: config.token,
        signal: clock.signal,
        timeoutMs: HTTP_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      };
      const protocol = await discoverActions(http);
      if (command.name === "exec") {
        const nonce = randomUUID();
        const executed = await execute(
          {
            machine: command.machine,
            ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
            argv: ["/bin/sh", "-c", START_BARRIER, "manifold-exec", nonce, ...command.argv],
            stream: new Capture(nonce, command.maxOutputBytes),
          },
          config,
          options,
          protocol,
          clock,
          receipts,
        );
        text = `${JSON.stringify({ type: "exec", ...executed.result })}\n`;
        exitCode = execExitCode(executed);
      } else if (command.name === "actions") {
        text = `${JSON.stringify({ type: "actions", ok: true, protocolVersion: protocol.protocolVersion, actions: protocol.actions })}\n`;
      } else {
        requireDoors(protocol, command.name === "doctor" ? EXEC_DOORS : ["core.machines.list"]);
        const roster = await machines(http, receipts);
        if (command.name === "machines")
          text = `${JSON.stringify({ type: "machines", ok: true, machines: roster, receipts })}\n`;
        else {
          session = sessionFor(config, options);
          const available = Promise.withResolvers<PluginRoster>();
          const offPlugins = session.onPlugins((plugins) => available.resolve(plugins));
          try {
            await clock.wait(session.connect());
            const plugins = await clock.wait(available.promise);
            if (
              EXEC_DOORS.some(
                (door) =>
                  !plugins.some(
                    (plugin) =>
                      plugin.enabled &&
                      plugin.held === undefined &&
                      plugin.actions.some((action) => action.name === door),
                  ),
              )
            )
              throw new ClientFailure("core_doors_unavailable");
          } finally {
            offPlugins();
          }
          const caps = session.selfCaps();
          if (
            !caps.includes("*") &&
            (!caps.includes("terminals:spawn") || !caps.includes("terminals:write"))
          )
            throw new ClientFailure("auth_refused");
          text = `${JSON.stringify({ type: "doctor", ok: true, protocolVersion: PROTOCOL_VERSION, binding: "terminal", coreDoors: "available", machineDiscovery: "authorized", session: "admitted", receipts })}\n`;
        }
      }
    }
  } catch (error) {
    const code = clock?.signal.aborted ? failure(clock.signal.reason) : failure(error);
    text = `${JSON.stringify({
      type: command?.name ?? "error",
      ok: false,
      diagnostic: diagnostic(code),
      protocolVersion: PROTOCOL_VERSION,
      receipts,
      ...(command?.name === "exec"
        ? notStarted({ encoding: "base64", data: "", bytes: 0, complete: false })
        : {}),
    })}\n`;
    exitCode = code === "cancelled" ? 130 : code === "timed_out" ? 124 : 1;
  } finally {
    session?.close();
    clock?.close();
  }
  try {
    options.output(text);
  } catch {
    return 1;
  }
  return exitCode;
}
