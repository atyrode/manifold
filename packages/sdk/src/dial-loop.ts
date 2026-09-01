/**
 * THE DIAL SKELETON: what every long-lived socket this SDK opens does regardless of what it
 * says on the wire.
 *
 * Two dial loops live in this package — the session channel's connection pool and the instance
 * channel's guest dial (ADR 0014) — and they were built independently around the same three
 * mechanisms: classify the frame's envelope, watch for a phantom transport, and come back with
 * jittered backoff. Independently is how they came to be near-identical copies, which is a
 * maintenance trap rather than a stylistic one: the identity-fence discipline below (a timer
 * callback the event loop has already queued cannot be retracted, so it re-checks that it is
 * still the live one) was fixed twice, and a fix landing in only one copy is a phantom socket
 * that never heals.
 *
 * What is NOT here is deliberate. Every policy that differs between the two loops — which
 * schema parses a frame, which close codes are terminal, what a reconnect re-sends, whether a
 * refusal is retryable at all — stays with the loop that owns it. This module holds only the
 * parts where a difference would be a bug, so a third dial loop inherits the fences instead of
 * copying them, and the protocol vocabulary above it stays each loop's own.
 */

import { reconnectDelayMs } from "@manifold/protocol";

/**
 * A malformed frame of a KNOWN type: the two ends disagree about a shape they both claim to
 * speak, so no state either holds is provable. Close with an application protocol error and
 * heal through the reconnect path (CONTRACTS.md).
 */
export const MALFORMED_FRAME_CLOSE_CODE = 4002;

/** Silence past the liveness deadline: dead TCP nobody RST. Closed locally by the watchdog. */
export const LIVENESS_CLOSE_CODE = 4008;

/**
 * What the ENVELOPE of an inbound frame answers, before any schema is consulted.
 *
 * The three outcomes are the whole forward-compatibility contract: an unknown `type` is ignored
 * (a newer peer may say things this end has no opinion about), a frame with no readable type
 * discriminator is malformed, and everything else is a typed envelope its owner still has to
 * validate. `raw` is handed back rather than re-parsed because the caller's schema — or its
 * hand-written hot-path predicate — is the half this module has no business knowing.
 */
export type ClassifiedEnvelope =
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "unknown_type" }
  | { readonly kind: "envelope"; readonly type: string; readonly raw: object };

/**
 * Reads one inbound frame far enough to route it: text, JSON, an object, a string `type`, and
 * a `type` this end knows. `known` is the caller's own vocabulary, so a peer's frame is never
 * measured against a table this module maintains.
 */
export function classifyEnvelope(
  data: unknown,
  known: (type: string) => boolean,
): ClassifiedEnvelope {
  if (typeof data !== "string") return { kind: "malformed", detail: "non-text frame" };
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "malformed", detail: "invalid JSON" };
  }
  if (raw === null || typeof raw !== "object") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  const type = Reflect.get(raw, "type");
  if (typeof type !== "string") return { kind: "malformed", detail: "missing type discriminator" };
  return known(type) ? { kind: "envelope", type, raw } : { kind: "unknown_type" };
}

export interface LivenessOptions {
  /** Silence deadline before the transport is declared a phantom. */
  readonly timeoutMs: number;
  /** Close reason, in the dialing side's own words (`"server silent past deadline"`). */
  readonly reason: string;
  /** The socket this loop currently owns; a stale timer fires against a superseded one. */
  readonly current: () => WebSocket | null;
}

/**
 * PHANTOM-TRANSPORT WATCHDOG, the dialing side of the one liveness scheme (CONTRACTS.md): a
 * healthy link carries peer pings every `DIAL_PING_INTERVAL_MS` even when idle, so silence past
 * the deadline means dead TCP nobody RST rather than a quiet peer. Closing LOCALLY is what puts
 * the connection on its own reconnect path — waiting for the OS to notice a half-open socket can
 * take the rest of the process's life.
 *
 * ANY inbound frame is proof of life, a peer ping included, so `arm` is called from `onmessage`
 * rather than from wherever the pong is written.
 */
export class LivenessWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LivenessOptions) {}

  /** (Re)starts the deadline for `socket`. */
  arm(socket: WebSocket): void {
    this.clear();
    const timer = setTimeout(() => {
      // clearTimeout cannot retract a callback the event loop has already queued; both checks
      // fence a stale one — the first against a rearm, the second against a superseded socket.
      if (this.timer !== timer) return;
      this.timer = null;
      if (this.options.current() !== socket) return;
      socket.close(LIVENESS_CLOSE_CODE, this.options.reason);
    }, this.options.timeoutMs);
    this.timer = timer;
  }

  clear(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface ReconnectOptions {
  /** First-attempt ceiling; the delay is half-jittered under it (`reconnectDelayMs`). */
  readonly baseMs: number;
  readonly capMs: number;
  /** Redials. Its own preconditions are the loop's: this fires only if the timer survived. */
  readonly dial: () => void;
}

/**
 * THE COMEBACK: one jittered, capped, identity-fenced retry timer, and the attempt counter the
 * backoff and the transport phase both read.
 *
 * The counter is the loop's own notion of "have I been up yet": zero means this is a first
 * connect (`connecting`), non-zero means a retry (`reconnecting`), and the loop resets it when
 * the peer proves the link works rather than when the socket merely opens — an open socket that
 * is refused at the handshake is not a successful attempt.
 */
export class ReconnectBackoff {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptCount = 0;

  constructor(private readonly options: ReconnectOptions) {}

  /** Attempts made since the last {@link reset}; zero before the first retry. */
  get attempts(): number {
    return this.attemptCount;
  }

  /** Whether a redial is already owed, so a caller does not schedule a second one. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** Schedules the next dial and consumes one attempt. */
  schedule(): void {
    const delay = reconnectDelayMs(this.attemptCount, this.options.baseMs, this.options.capMs);
    this.attemptCount += 1;
    const timer = setTimeout(() => {
      // Same fence as the watchdog's, for the same reason: a queued callback outlives its
      // clearTimeout, and firing it after a teardown or a manual redial would dial twice.
      if (this.timer !== timer) return;
      this.timer = null;
      this.options.dial();
    }, delay);
    this.timer = timer;
  }

  /** The link works: the next drop is a first retry again, not the tail of an old series. */
  reset(): void {
    this.attemptCount = 0;
  }

  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
