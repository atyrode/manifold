import type { RuntimeDeps } from "@manifold/protocol";

/** Allowed severity labels for the server's JSONL operational stream. */
export type LogLevel = "info" | "warn" | "error";

/** Logging boundary used by stateful services so tests can capture events without stdout. */
export interface Logger {
  info(evt: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(evt: string, fields?: Readonly<Record<string, unknown>>): void;
  error(evt: string, fields?: Readonly<Record<string, unknown>>): void;
}

const SECRET_FIELD = /(token|key|authorization|secret)/i;
const TERMINAL_FIELD = /^(data|env|payload|terminalData)$/i;

function safeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(name) || TERMINAL_FIELD.test(name)) continue;
    if (Array.isArray(value)) {
      safe[name] = value.map((entry) => {
        if (entry !== null && typeof entry === "object") {
          return safeFields(Object.fromEntries(Object.entries(entry)));
        }
        return entry;
      });
      continue;
    }
    if (value !== null && typeof value === "object") {
      safe[name] = safeFields(Object.fromEntries(Object.entries(value)));
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
    evt: string,
    fields: Readonly<Record<string, unknown>> | undefined,
  ): void {
    const record: Record<string, unknown> = {
      ts: this.runtime.now(),
      level,
      evt,
      ...(fields === undefined ? {} : safeFields(fields)),
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  info(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("info", evt, fields);
  }

  warn(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("warn", evt, fields);
  }

  error(evt: string, fields?: Readonly<Record<string, unknown>>): void {
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
