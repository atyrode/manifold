import { HubHttpError, HubRefusal, ownerAction, parseHubUrl } from "@manifold/plugin-kit/hub";
import { resolveOwnerKey } from "@manifold/plugin-kit/install";
import {
  MachineDrainStatusSchema,
  TERMINAL_HOST_PROTOCOL_VERSION,
  type ActionDenialRule,
} from "@manifold/protocol";
import { ZodError } from "zod";
import { unixTerminalHostDialer, type TerminalHostLink } from "./terminal-host-link.ts";

const OWNER_TIMEOUT_MS = 30_000;
// IPC 1 and IPC 2 share these maintenance frames. Accepting a retained IPC 1
// owner's shutdown decision grants no authority to launch unconfined work.
const MAINTENANCE_PROTOCOL_VERSIONS = new Set([1, TERMINAL_HOST_PROTOCOL_VERSION]);
const HELP = `usage:
  manifold-agent --maintenance drain --hub URL --machine-id ID --owner-key-file FILE
  manifold-agent --maintenance reopen --hub URL --machine-id ID --owner-key-file FILE
  manifold-agent --maintenance shutdown --socket PATH --terminal-host-id ID
  manifold-agent --maintenance --help

Only explicitly named references are used. Owner keys are read inside Manifold, never
accepted as arguments. In the owning container, run the same command with:
  bun packages/agent/src/main.ts --maintenance drain --hub URL --machine-id ID --owner-key-file /data/owner.key

Drain closes admission; it is not proof of idle or shutdown. Reopen explicitly cancels
the drain. Shutdown is an observer request to the named owner, which must itself
confirm it is drained and retains neither terminals nor jobs. No command retries,
attaches a transport, retires terminals, cancels jobs, or changes a supervisor.
A failure means hold: a drain latch may already have persisted. Never infer rollback.
`;

type Command = "drain" | "reopen" | "shutdown";
type FailureReason =
  | "invalid_arguments"
  | "credential_unavailable"
  | "action_refused"
  | "request_failed"
  | "invalid_response"
  | "drain_state_mismatch"
  | "owner_identity_mismatch"
  | "owner_protocol_mismatch"
  | "owner_disconnected"
  | "owner_timeout"
  | "not_draining"
  | "terminals_retained"
  | "jobs_retained"
  | "unexpected_owner_event";

type Failure = {
  readonly ok: false;
  readonly hold: true;
  readonly reason: FailureReason;
  readonly terminalIds?: readonly string[];
  readonly rule?: ActionDenialRule;
  readonly status?: number;
};

type Outcome =
  | Failure
  | {
      readonly ok: true;
      readonly command: "drain" | "reopen";
      readonly machineId: string;
      readonly terminalHostId: string;
      readonly draining: boolean;
      readonly terminalIds: readonly string[];
    }
  | { readonly ok: true; readonly command: "shutdown"; readonly terminalHostId: string };

type Options =
  | {
      readonly command: "drain" | "reopen";
      readonly hub: string;
      readonly machineId: string;
      readonly ownerKeyFile: string;
    }
  | { readonly command: "shutdown"; readonly socket: string; readonly terminalHostId: string };

function isCommand(value: string | undefined): value is Command {
  return value === "drain" || value === "reopen" || value === "shutdown";
}

function failure(reason: FailureReason): Failure {
  return { ok: false, hold: true, reason };
}

function parseOptions(args: readonly string[]): Options {
  const command = args[0];
  if (!isCommand(command)) throw new Error("invalid_arguments");
  const allowed =
    command === "shutdown"
      ? ["--socket", "--terminal-host-id"]
      : ["--hub", "--machine-id", "--owner-key-file"];
  const flags = new Map<string, string>();
  for (let at = 1; at < args.length; at += 2) {
    const flag = args[at];
    const value = args[at + 1];
    if (
      flag === undefined ||
      !allowed.includes(flag) ||
      flags.has(flag) ||
      value === undefined ||
      value.trim() === "" ||
      value.startsWith("--") ||
      /\p{Cc}/u.test(value)
    ) {
      throw new Error("invalid_arguments");
    }
    flags.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = flags.get(flag);
    if (value === undefined) throw new Error("invalid_arguments");
    return value;
  };
  if (command === "shutdown") {
    return {
      command,
      socket: required("--socket"),
      terminalHostId: required("--terminal-host-id"),
    };
  }
  const rawHub = required("--hub");
  const url = new URL(rawHub);
  // The kit accepts origins; reject credentials instead of silently stripping them.
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new Error("invalid_arguments");
  }
  return {
    command,
    hub: parseHubUrl(rawHub),
    machineId: required("--machine-id"),
    // Required and nonempty: resolveOwnerKey cannot fall back to ambient configuration.
    ownerKeyFile: required("--owner-key-file"),
  };
}

async function setDrain(
  options: Extract<Options, { command: "drain" | "reopen" }>,
): Promise<Outcome> {
  let ownerKey: string;
  try {
    ownerKey = await resolveOwnerKey(options.ownerKeyFile, undefined);
  } catch {
    return failure("credential_unavailable");
  }
  const draining = options.command === "drain";
  let result: unknown;
  try {
    result = await ownerAction({ url: options.hub, ownerKey }, "core.machines.drain", {
      machineId: options.machineId,
      draining,
    });
  } catch (error) {
    if (error instanceof HubRefusal) return { ...failure("action_refused"), rule: error.rule };
    if (error instanceof ZodError) return failure("invalid_response");
    if (error instanceof HubHttpError) {
      return {
        ...failure(
          error.status >= 200 && error.status < 300 ? "invalid_response" : "request_failed",
        ),
        status: error.status,
      };
    }
    return failure("request_failed");
  }
  const parsed = MachineDrainStatusSchema.safeParse(result);
  if (!parsed.success) return failure("invalid_response");
  if (parsed.data.draining !== draining) return failure("drain_state_mismatch");
  return {
    ok: true,
    command: options.command,
    machineId: options.machineId,
    terminalHostId: parsed.data.terminalHostId,
    draining: parsed.data.draining,
    terminalIds: parsed.data.terminalIds,
  };
}

function closeLink(link: TerminalHostLink): void {
  try {
    link.close();
  } catch {
    // Cleanup must never replace a classified outcome with socket exception details.
  }
}

function shutdownOwner(options: Extract<Options, { command: "shutdown" }>): Promise<Outcome> {
  const { promise, resolve } = Promise.withResolvers<Outcome>();
  let link: TerminalHostLink | undefined;
  let settled = false;
  let phase: "connecting" | "status" | "shutdown" = "connecting";
  const finish = (outcome: Outcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (link !== undefined) closeLink(link);
    resolve(outcome);
  };
  const timer = setTimeout(() => finish(failure("owner_timeout")), OWNER_TIMEOUT_MS);
  try {
    void unixTerminalHostDialer(options.socket)({
      onEvent(event) {
        if (settled) return;
        // No unsolicited event can authorize a mutation through an unresolved link.
        if (phase === "connecting") {
          finish(failure("unexpected_owner_event"));
          return;
        }
        if (event.type === "status") {
          if (event.terminalHostId !== options.terminalHostId) {
            finish(failure("owner_identity_mismatch"));
          } else if (!MAINTENANCE_PROTOCOL_VERSIONS.has(event.terminalHostProtocolVersion)) {
            finish(failure("owner_protocol_mismatch"));
          } else if (phase !== "status" || link === undefined) {
            finish(failure("unexpected_owner_event"));
          } else {
            // Status proves identity and protocol, NOT emptiness. Only the owner's
            // atomic shutdown admission check can prove that terminals and jobs are gone.
            phase = "shutdown";
            try {
              link.send({ type: "shutdown_request" });
            } catch {
              finish(failure("owner_disconnected"));
            }
          }
          return;
        }
        if (phase === "shutdown" && event.type === "shutdown_refused") {
          finish({ ...failure(event.reason), terminalIds: event.terminalIds });
          return;
        }
        if (phase === "shutdown" && event.type === "shutting_down") {
          finish(
            event.terminalHostId === options.terminalHostId
              ? { ok: true, command: "shutdown", terminalHostId: event.terminalHostId }
              : failure("owner_identity_mismatch"),
          );
          return;
        }
        finish(failure(event.type === "error" ? "invalid_response" : "unexpected_owner_event"));
      },
      onClose(detail) {
        finish(
          failure(
            detail === "malformed_frame" ||
              detail.startsWith("malformed_frame:") ||
              detail === "frame_too_large" ||
              detail === "queue_exceeded"
              ? "invalid_response"
              : "owner_disconnected",
          ),
        );
      },
    }).then(
      (connected) => {
        if (settled) {
          closeLink(connected);
          return;
        }
        link = connected;
        phase = "status";
        try {
          connected.send({ type: "status_request" });
        } catch {
          finish(failure("owner_disconnected"));
        }
      },
      () => finish(failure("owner_disconnected")),
    );
  } catch {
    finish(failure("owner_disconnected"));
  }
  return promise;
}

/** Runs arguments after --maintenance; all failures are safe, stable, hold-required JSON. */
export async function runMaintenanceCLI(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  const command = isCommand(args[0]) ? args[0] : undefined;
  let options: Options;
  try {
    options = parseOptions(args);
  } catch {
    process.stderr.write(
      `${JSON.stringify({ ...failure("invalid_arguments"), ...(command ? { command } : {}) })}\n`,
    );
    return 1;
  }
  let outcome: Outcome;
  try {
    outcome =
      options.command === "shutdown" ? await shutdownOwner(options) : await setDrain(options);
  } catch {
    outcome = failure("request_failed");
  }
  if (outcome.ok) {
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return 0;
  }
  process.stderr.write(`${JSON.stringify({ ...outcome, command: options.command })}\n`);
  return 1;
}
