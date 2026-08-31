import { parseManifoldUri } from "@manifold/protocol";

/** One spotlight per pair per two seconds: an interruption, not a stream (D6). */
const SPOTLIGHT_MIN_INTERVAL_MS = 2_000;
/** Above this many tracked pairs, stale rows are swept before a new one is added. */
const SPOTLIGHT_PAIRS_LIMIT = 1_024;

/**
 * Last accepted spotlight per (caller, target). Module state because the limit belongs to
 * the plugin's behaviour rather than to any one request, and it is deliberately ephemeral:
 * a restart forgetting who was recently pointed at costs one extra allowed interruption.
 *
 * Bounded, not periodically swept, ON PURPOSE: the map holds at most
 * SPOTLIGHT_PAIRS_LIMIT rows of two short id strings (a few tens of KB at the very worst),
 * sweeping stale rows only when the cap is reached. A timer would be recurring machinery
 * buying nothing but a smaller number that is already small.
 */
const lastSpotlightAt = new Map<string, number>();

/**
 * The slice of the host this plugin touches, declared locally (D1): who is asking, one
 * authority question, live shared membership, and the presence write. No store, no broker —
 * a spotlight is presence, so it must not be able to reach anything durable.
 */
interface PresenceCtx {
  readonly principal: { readonly id: string };
  readonly auth: {
    allows(cap: "scenes:write", containerId?: string): boolean;
  };
  readonly rooms: {
    sharedContainerIds(left: string, right: string): readonly string[];
    setSpotlight(
      containerId: string,
      principalId: string,
      spotlight: { uri: string; from: string },
    ): boolean;
  };
  now(): number;
}

/** Either the empty result the action publishes, or a refusal the door turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

/**
 * Driving another principal's view is guarded three ways, and each guard answers a
 * different objection:
 *
 * - the URI must be an address (`manifold://…`), because a spotlight names a NODE and a
 *   client cannot center on prose;
 * - the two principals must already share a live room AND the caller must hold
 *   `scenes:write` there — consent is structural rather than a setting: you may point at
 *   somebody you are working with, in the place you are working together;
 * - one spotlight per pair per two seconds, so the door cannot be turned into a viewport
 *   jammer. A denied attempt does not consume the budget; only an accepted one does.
 */
export const presenceHandlers = {
  async focus(
    ctx: PresenceCtx,
    args: { targetPrincipalId: string; uri: string },
  ): Promise<Outcome> {
    if (parseManifoldUri(args.uri) === null) {
      return { refused: "uri is not a manifold:// address" };
    }
    const caller = ctx.principal.id;
    const target = args.targetPrincipalId;
    const shared = ctx.rooms.sharedContainerIds(caller, target);
    if (shared.length === 0) {
      return { refused: "no room shared with that principal" };
    }
    const containerId = shared.find((candidate) => ctx.auth.allows("scenes:write", candidate));
    if (containerId === undefined) {
      return { refused: "scenes:write capability required in a shared room" };
    }

    const pair = `${caller}\u0000${target}`;
    const now = ctx.now();
    const previous = lastSpotlightAt.get(pair);
    if (previous !== undefined && now - previous < SPOTLIGHT_MIN_INTERVAL_MS) {
      return { refused: "throttled" };
    }
    if (!ctx.rooms.setSpotlight(containerId, target, { uri: args.uri, from: caller })) {
      return { refused: "that principal is no longer in the room" };
    }
    if (lastSpotlightAt.size >= SPOTLIGHT_PAIRS_LIMIT) {
      for (const [key, at] of lastSpotlightAt) {
        if (now - at >= SPOTLIGHT_MIN_INTERVAL_MS) lastSpotlightAt.delete(key);
      }
    }
    lastSpotlightAt.set(pair, now);
    return {};
  },
};
