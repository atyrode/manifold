import {
  ACTION_TRACE_ID_HEADER,
  AGENT_JUSTIFICATION_HEADER,
  ActionOutcomeSchema,
  ActionProtocolSchema,
  HttpErrorSchema,
  PROTOCOL_VERSION,
  encodeAgentJustification,
  type ActionOutcome,
  type ActionProtocol,
} from "@manifold/protocol";

export interface ActionHttpOptions {
  readonly origin: string;
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface ActionInvocation {
  readonly outcome: ActionOutcome;
  /** Null means the peer did not supply a durable reference; it is never synthesized. */
  readonly traceId: number | null;
}

export class ActionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly traceId: number | null = null,
  ) {
    super(message);
    this.name = "ActionHttpError";
  }
}

export class ActionProtocolError extends Error {
  constructor(readonly code: "incompatible_protocol" | "invalid_response") {
    super(code);
    this.name = "ActionProtocolError";
  }
}

function withoutTrailingSlashes(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin.charCodeAt(end - 1) === 47) end--;
  return end === origin.length ? origin : origin.slice(0, end);
}

/** One authenticated HTTP implementation for sessions, tooling and the bounded runner. */
async function request(
  options: ActionHttpOptions,
  path: string,
  invocation?: { args: unknown; agentJustification?: string },
): Promise<{ payload: unknown; traceId: number | null }> {
  const headers = new Headers({
    authorization: `Bearer ${options.token}`,
    accept: "application/json",
  });
  if (invocation !== undefined) {
    headers.set("content-type", "application/json");
    if (invocation.agentJustification !== undefined) {
      headers.set(
        AGENT_JUSTIFICATION_HEADER,
        encodeAgentJustification(invocation.agentJustification),
      );
    }
  }
  let signal = options.signal;
  if (options.timeoutMs !== undefined) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    signal = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  }
  const response = await fetch(`${withoutTrailingSlashes(options.origin)}${path}`, {
    method: invocation === undefined ? "GET" : "POST",
    headers,
    body: invocation === undefined ? null : JSON.stringify(invocation.args ?? {}),
    ...(signal === undefined ? {} : { signal }),
    // Never send a process-owned bearer through a redirect or browser ambient credentials.
    redirect: "error",
    credentials: "omit",
  });
  const rawTrace = response.headers.get(ACTION_TRACE_ID_HEADER);
  const numericTrace = rawTrace !== null && /^[1-9][0-9]*$/.test(rawTrace) ? Number(rawTrace) : NaN;
  const traceId = Number.isSafeInteger(numericTrace) ? numericTrace : null;
  const reader = response.body?.getReader();
  let payload: unknown;
  if (reader === undefined)
    throw new ActionHttpError(response.status, "empty JSON response", traceId);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pieces: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (options.maxResponseBytes !== undefined && bytes > options.maxResponseBytes) {
        throw new ActionHttpError(response.status, "HTTP response exceeds limit", traceId);
      }
      pieces.push(decoder.decode(chunk.value, { stream: true }));
    }
    pieces.push(decoder.decode());
    payload = JSON.parse(pieces.join(""));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ActionHttpError) throw error;
    throw new ActionHttpError(response.status, "non-JSON response", traceId);
  } finally {
    reader.releaseLock();
  }
  if (!response.ok) {
    const failure = HttpErrorSchema.safeParse(payload);
    throw new ActionHttpError(
      response.status,
      failure.success ? failure.data.error.message : `HTTP request failed (${response.status})`,
      traceId,
    );
  }
  return { payload, traceId };
}

/** Reads authoritative installed schemas, refusing an incompatible wire rather than guessing. */
export async function discoverActions(options: ActionHttpOptions): Promise<ActionProtocol> {
  const { payload } = await request(options, "/api/protocol");
  const parsed = ActionProtocolSchema.safeParse(payload);
  if (!parsed.success) throw new ActionProtocolError("invalid_response");
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    throw new ActionProtocolError("incompatible_protocol");
  }
  if (
    new Set(parsed.data.actions.map((action) => action.name)).size !== parsed.data.actions.length
  ) {
    throw new ActionProtocolError("invalid_response");
  }
  return parsed.data;
}

export async function invokeAction(
  options: ActionHttpOptions,
  name: string,
  args: unknown,
  metadata: { agentJustification?: string } = {},
): Promise<ActionInvocation> {
  const { payload, traceId } = await request(options, `/api/actions/${encodeURIComponent(name)}`, {
    args,
    ...metadata,
  });
  const parsed = ActionOutcomeSchema.safeParse(payload);
  if (!parsed.success) throw new ActionHttpError(200, "invalid action response", traceId);
  return { outcome: parsed.data, traceId };
}
