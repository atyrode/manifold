import type { LogEvent } from "@manifold/protocol";

/**
 * Structured log record; `ts` is stamped from the injected runtime clock.
 *
 * `evt` is the closed vocabulary the server half shares (`LOG_EVENTS`, `@manifold/protocol`):
 * one JSONL shape, one list of names, and e2e gates match those names inside raw agent stdout
 * where no type can reach them (S14). Both halves of the machine — the terminal host and the
 * transport — write this one shape, so a reader of either stream reads one vocabulary.
 */
export interface AgentLogRecord {
  readonly ts: number;
  readonly level: "info" | "warn" | "error";
  readonly evt: LogEvent;
  readonly [field: string]: unknown;
}

/** Where structured logs go. main.ts writes them as JSONL to stdout; tests drop them. */
export type AgentLogSink = (record: AgentLogRecord) => void;
