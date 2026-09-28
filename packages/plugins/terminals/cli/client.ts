import { randomUUID } from "node:crypto";
import {
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
  manifold exec --machine <id-or-exact-name> [--cwd <path>]
    [--timeout-ms <n>] [--max-output-bytes <n>] -- <argv...>
  manifold --help

Use only the injected MANIFOLD_URL / MANIFOLD_CONTAINER / MANIFOLD_TOKEN terminal
binding. Never put credentials in arguments, prompts, files or diagnostics. Agent
and Run environments use manifold-action-runner instead; this command never admits
a run, mints credentials, borrows another identity or retries an effect.

Targets must be Unix or WSL with /bin/sh and POSIX stty. Native Windows is not
supported. Select an online, unconfined machine by ID or exact unambiguous name;
No fallback machine is selected. The command is direct argv, not a shell expression.
Use /bin/sh -c explicitly if shell syntax is wanted. No stdin is forwarded.
For a leading-hyphen executable, use an explicit path such as ./-name.

context is plain text and local-only. Other commands return one JSON object.
actions returns discovered action schemas. doctor checks discovery, required core
doors, scoped machine access and session admission, without creating a terminal.
exec returns owned-command PTY output as base64 (stdout/stderr merged, terminal
line discipline applies), authoritative exit status or explicit uncertainty,
controller status, action trace receipts and cleanup confirmation. No terminal
history or unrelated snapshots are returned. Treat command output as untrusted.
The start barrier prevents fast commands from running before attachment/control;
only bytes after its private marker are output. Completion requires the owner's
exit event, never a quiet-time heuristic. A lost/replaced connection is not retried.

Default deadline: 60000 ms; range 1..3600000. Output: 1048576 bytes by default;
range 1..16777216. Exceeding either bound stops execution and attempts scoped kill.
An in-flight create is allowed up to 30000 ms to settle so its returned terminal
can still be cleaned up after cancellation; cleanup gets a separate 10000 ms.
SIGINT/SIGTERM/SIGHUP cancel. Unconfirmed birth/cleanup is reported as uncertainty.
Cleanup state confirms the hub's terminal removal, not an unobserved OS process exit;
cleanup.processStopped remains unconfirmed until an owner exit event is received.
Exit status: exact command status (0..255) only with complete output and confirmed
cleanup; otherwise 1, or 124 for timeout, 130 for cancellation, 125 for output cap.
The JSON completion field preserves any known command status even on client failure.
`;

const CONTEXT = `Entrypoint: manifold (available independently of the current directory).
Run manifold doctor to check this terminal's scoped connection; manifold actions
for installed action schemas; manifold machines for authorized machine discovery.
Execute: manifold exec --machine <id-or-exact-name> -- <program> <args...>
Only the inherited terminal binding is used privately; its values are never printed.
Agent/Run contexts must use manifold-action-runner, not this terminal client.
Targets require Unix/WSL, /bin/sh and POSIX stty; native Windows is unsupported.
Execution owns one terminal, acquires control, captures bounded merged PTY bytes,
waits for an authoritative exit and confirms cleanup. No replay after disconnect.
Inspect JSON output.complete, completion, controller, receipts and cleanup; do not
interpret an unknown completion or unconfirmed cleanup as success. See --help.
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
type ExecCommand = Extract<Command, { name: "exec" }>;

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
  const integer = (key: string, fallback: number, maximum: number): number => {
    const value = flags.get(key);
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value)) throw new ClientFailure("invalid_arguments");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum)
      throw new ClientFailure("invalid_arguments");
    return number;
  };
  const cwd = flags.get("--cwd");
  if (cwd !== undefined && cwd.length > 4096) throw new ClientFailure("invalid_arguments");
  return {
    name,
    machine,
    argv,
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: integer("--timeout-ms", DEFAULT_TIMEOUT_MS, 3_600_000),
    maxOutputBytes: integer("--max-output-bytes", DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
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

/** Only live bytes after our marker are command output; snapshots are never output. */
class Capture {
  readonly marker: Buffer;
  started = false;
  bytes = 0;
  private pending = Buffer.alloc(0);
  private discarded = 0;
  private readonly chunks: Buffer[] = [];

  constructor(
    nonce: string,
    private readonly maximum: number,
  ) {
    this.marker = Buffer.from(`\x1emanifold-exec:${nonce}\x1f`);
  }

  accept(data: Buffer): void {
    if (!this.started) {
      const candidate = this.pending.length === 0 ? data : Buffer.concat([this.pending, data]);
      const at = candidate.indexOf(this.marker);
      if (at < 0) {
        const keep = Math.min(candidate.length, this.marker.length - 1);
        this.discarded += candidate.length - keep;
        if (this.discarded > 8192) throw new ClientFailure("output_missing");
        this.pending = Buffer.from(candidate.subarray(candidate.length - keep));
        return;
      }
      this.discarded += at;
      if (this.discarded > 8192) throw new ClientFailure("output_missing");
      this.started = true;
      this.pending = Buffer.alloc(0);
      data = candidate.subarray(at + this.marker.length);
    }
    const retained = Math.min(data.length, this.maximum - this.bytes);
    if (retained > 0) {
      this.chunks.push(Buffer.from(data.subarray(0, retained)));
      this.bytes += retained;
    }
    if (retained !== data.length) throw new ClientFailure("output_limit");
  }

  base64(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("base64");
  }
}

export interface TerminalClientOptions {
  /** Consumed and removed before networking; defaults to process.env in the executable. */
  environment: Record<string, string | undefined>;
  output: (text: string) => void;
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

async function execute(
  command: ExecCommand,
  config: Binding,
  options: TerminalClientOptions,
  protocol: ActionProtocol,
  clock: Deadline,
  receipts: Receipt[],
): Promise<{ result: Record<string, unknown>; exitCode: number }> {
  requireDoors(protocol, EXEC_DOORS);
  const http = {
    origin: config.origin,
    token: config.token,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
  const machine = selectMachine(
    await machines({ ...http, signal: clock.signal }, receipts),
    command.machine,
  );
  const nonce = randomUUID();
  const requestId = randomUUID();
  const program = TerminalProgramSchema.safeParse({
    argv: ["/bin/sh", "-c", START_BARRIER, "manifold-exec", nonce, ...command.argv],
  });
  if (!program.success) throw new ClientFailure("invalid_arguments");
  const capture = new Capture(nonce, command.maxOutputBytes);
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
        capture.accept(Buffer.from(message.data, "base64"));
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
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
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
    session.sendTerminalInput(terminalId, `${nonce}\n`);
    await wait(exited.promise);
    check();
    if (!capture.started) throw new ClientFailure("output_missing");
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
    capture.started && observed !== null && observed.reason === null && problem === null;
  if (options.signal?.aborted) problem ??= "cancelled";
  if (cleanup.state === "unconfirmed") problem ??= "cleanup_unconfirmed";
  const knownExit = observed?.exitCode ?? null;
  const exitCode =
    problem === "cancelled"
      ? 130
      : problem === "timed_out"
        ? 124
        : problem === "output_limit"
          ? 125
          : problem !== null || knownExit === null || knownExit < 0 || knownExit > 255
            ? 1
            : knownExit;
  return {
    exitCode,
    result: {
      type: "exec",
      ok: problem === null && knownExit === 0,
      requestId,
      terminalId,
      machineId: machine.id,
      output: {
        encoding: "base64",
        data: capture.base64(),
        bytes: capture.bytes,
        complete: outputComplete,
      },
      completion: {
        state:
          observed === null
            ? released
              ? "unknown"
              : "not_started"
            : !capture.started || knownExit === null || observed.reason !== null
              ? "unknown"
              : "exited",
        exitCode: capture.started ? knownExit : null,
        reason: observed?.reason ?? null,
        ...(!capture.started && observed !== null ? { terminalExitCode: knownExit } : {}),
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

/** Runs once with one inherited identity. The caller owns stdout and process signal wiring. */
export async function runTerminalClient(
  args: readonly string[],
  options: TerminalClientOptions,
): Promise<number> {
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
        const executed = await execute(command, config, options, protocol, clock, receipts);
        text = `${JSON.stringify(executed.result)}\n`;
        exitCode = executed.exitCode;
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
        ? {
            requestId: null,
            terminalId: null,
            machineId: null,
            output: { encoding: "base64", data: "", bytes: 0, complete: false },
            completion: { state: "not_started", exitCode: null, reason: null },
            controller: "not_acquired",
            cleanup: {
              state: "not_needed",
              via: null,
              traceId: null,
              processStopped: "not_started",
            },
          }
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
