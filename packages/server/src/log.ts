import type { LogEvent, RuntimeDeps } from "@manifold/protocol";

/** Allowed severity labels for the server's JSONL operational stream. */
export type LogLevel = "info" | "warn" | "error";

/**
 * Logging boundary used by stateful services so tests can capture events without stdout.
 *
 * `evt` is the closed vocabulary (`LOG_EVENTS`, `@manifold/protocol`), not a free string: the
 * agent half writes the same records into the same JSONL shape and the e2e gates match these
 * names inside raw stdout, so a typo here is a silently rotten assertion there. S14 checks the
 * half no type can reach.
 */
export interface Logger {
  info(evt: LogEvent, fields?: Readonly<Record<string, unknown>>): void;
  warn(evt: LogEvent, fields?: Readonly<Record<string, unknown>>): void;
  error(evt: LogEvent, fields?: Readonly<Record<string, unknown>>): void;
}

/**
 * THE ONE REDACTION RULE, by field name.
 *
 * It was written for the JSONL stream and is now also what the trace ledger writes an
 * argument object through (axiom A6, ADR 0018 §5): both are durable records of what a
 * principal did, and "which fields may never leave the process" is one question with one
 * answer (invariant 14). `SECRET_FIELD` is AGENTS invariant 6 — no owner key, no token, no
 * bearer secret, anywhere — and `TERMINAL_FIELD` is invariant 5: terminal bytes are never
 * persisted, so an argument carrying them cannot be persisted either.
 *
 * Matching by NAME rather than by declaration is deliberate. A per-action `redact` list would
 * be a second vocabulary a door author must remember to fill in, and the failure mode of
 * forgetting is a secret in the ledger; a name rule fails the other way — an innocent field
 * called `key` is dropped from a record — which costs an auditor one field and costs nobody a
 * credential.
 */
const SECRET_FIELD = /(token|key|authorization|secret|password|passwd|credential|passphrase)/i;
const TERMINAL_FIELD = /^(data|env|payload|terminalData)$/i;

export function redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(name) || TERMINAL_FIELD.test(name)) continue;
    if (Array.isArray(value)) {
      safe[name] = value.map((entry) => {
        if (entry !== null && typeof entry === "object") {
          return redactFields(Object.fromEntries(Object.entries(entry)));
        }
        return entry;
      });
      continue;
    }
    if (value !== null && typeof value === "object") {
      safe[name] = redactFields(Object.fromEntries(Object.entries(value)));
      continue;
    }
    safe[name] = value;
  }
  return safe;
}

class JsonLogger implements Logger {
  constructor(private readonly runtime: RuntimeDeps) {}

  private write(
    level: LogLevel,
    evt: LogEvent,
    fields: Readonly<Record<string, unknown>> | undefined,
  ): void {
    const record: Record<string, unknown> = {
      ts: this.runtime.now(),
      level,
      evt,
      ...(fields === undefined ? {} : redactFields(fields)),
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  info(evt: LogEvent, fields?: Readonly<Record<string, unknown>>): void {
    this.write("info", evt, fields);
  }

  warn(evt: LogEvent, fields?: Readonly<Record<string, unknown>>): void {
    this.write("warn", evt, fields);
  }

  error(evt: LogEvent, fields?: Readonly<Record<string, unknown>>): void {
    this.write("error", evt, fields);
  }
}

/** Creates the production JSONL logger, with secret and terminal-byte fields stripped. */
export function createLogger(runtime: RuntimeDeps): Logger {
  return new JsonLogger(runtime);
}

/** Silent logger for focused unit tests and embedders that own their log sink. */
export const silentLogger: Logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};
