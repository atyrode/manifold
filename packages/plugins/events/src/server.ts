import { EVENTS_LIST_DEFAULT, type EventRow } from "./index.ts";

/**
 * The slice of the host this plugin touches, declared locally (D1): one read, on one table.
 *
 * It is the narrowest slice any plugin in the tree declares, and that is the point of
 * declaring it. No rooms, no broker, no identity, no `storage` — this door cannot write
 * anything, cannot mint anything, and cannot observe anything live. `assembly.ts` checks the
 * shape against the real `ActionCtx` by assignment, so a later version of this plugin that
 * wanted more would fail that assignment rather than quietly reach further into the server.
 */
interface EventsCtx {
  readonly store: {
    listEvents(filter: {
      readonly containerId?: string;
      readonly type?: string;
      readonly limit: number;
    }): readonly EventRow[];
  };
}

/** What the door hands over once its schema has parsed: every field optional, all bounded. */
interface ListArgs {
  readonly limit?: number;
  readonly kind?: string;
  readonly containerId?: string;
}

/**
 * The trail, newest first.
 *
 * There is nothing to decide here and that is deliberate — the ordering, the index it rides,
 * the retention window and the row shape all belong to the store, and the bound belongs to the
 * action's schema. What the handler owns is the TRANSLATION: the caller's `kind` is the store's
 * `type`, and an absent `limit` becomes the declared default rather than an unbounded read.
 *
 * The filters are passed through only when present. That is `exactOptionalPropertyTypes`
 * showing up as a real distinction rather than a compiler nuisance: `{ containerId: undefined }`
 * and `{}` must not mean different things to a store that branches on which index to use, and
 * spreading conditionally is how the absence stays an absence.
 */
export const eventsHandlers = {
  async list(ctx: EventsCtx, args: ListArgs): Promise<{ events: readonly EventRow[] }> {
    return {
      events: ctx.store.listEvents({
        limit: args.limit ?? EVENTS_LIST_DEFAULT,
        ...(args.kind === undefined ? {} : { type: args.kind }),
        ...(args.containerId === undefined ? {} : { containerId: args.containerId }),
      }),
    };
  },
};
