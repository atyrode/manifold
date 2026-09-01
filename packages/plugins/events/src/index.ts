import { defineAction } from "@manifold/plugin";
import type { PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/**
 * The audit trail, as a door.
 *
 * The server has recorded events since the first migration — a principal arriving in a
 * container, a terminal opening, moving or dying, a token minted or revoked — and until now
 * nothing could read them back. They were written by five floor files and reachable only by
 * opening the SQLite file, which makes the trail's existence a fact about the database rather
 * than a fact about the workspace: an agent cannot answer "what happened here?" (A2), and a
 * human cannot either without a shell on the host.
 *
 * DOOR-ONLY, deliberately. This plugin contributes no panel, no section, no element and no
 * tool: what the trail should LOOK like is a screen somebody has to design, and the door is
 * what makes designing it possible without another conversion. The precedent is `core.access`,
 * which shipped three verbs and no UI for the same reason — the read is the reusable half, and
 * a roster row for a plugin that draws nothing is still the honest published truth that the
 * capability exists.
 *
 * NOT `essential`: losing the ability to read history costs visibility, never the ability to
 * work or to administer, and the rows keep accruing while the plugin is off (a disable retains,
 * ADR 0013 §1) so turning it back on restores the whole trail rather than a stump.
 */
export const eventsManifest: PluginManifest = {
  id: "core.events",
  version: "1.0.0",
  title: "Events",
  description:
    "Reads the workspace's recorded event history over the API; contributes no interface this wave.",
  /*
    `*` is the ceiling this manifest publishes, and it is the real one: the single action below
    demands root. A manifest is a readable ceiling on a plugin's authority precisely so a
    reader can see, without opening the code, that this one is not for delegated tokens.
  */
  capabilities: ["*"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

/**
 * How many rows one call may ask for, and the default when it does not ask.
 *
 * The trail's real bound is the store's retention — 30 days, and 10,000 rows per container —
 * and 500 is deliberately far below it. A read door's maximum is a promise about the size of
 * one answer, not about the size of the history: 500 rows is what a human scrolls or an agent
 * reasons over in a single pass, and it keeps a response inside the same order of magnitude as
 * the 1 MiB ceiling the API already sets on a body. Reading the whole trail therefore needs
 * paging, and paging needs a cursor this wave does not invent — an unbounded read would be
 * cheaper to write and would turn one call into an allocation of the entire table.
 */
export const EVENTS_LIST_MAX = 500;
export const EVENTS_LIST_DEFAULT = 100;

/**
 * One row as the wire carries it.
 *
 * DECLARED HERE rather than in `@manifold/protocol`, and that is the opposite of the call
 * `core.machines` made — worth stating because both are right. `MachineSummary` lives in the
 * protocol because the SDK parses it and the machine channel describes its own vocabulary in
 * it: two planes already spoke that shape, so a private copy would have been the second
 * convention invariant 14 forbids. Nothing outside this plugin has ever named an event row.
 * Promoting one into the protocol would be publishing a wire type with a single reader, and
 * the roster already publishes this schema as JSON Schema at `GET /api/protocol` — so a
 * stranger's client gets the same machine-readable shape either way, without the floor
 * acquiring a vocabulary word for a feature that could be turned off.
 *
 * `containerId` and `principalId` are nullable because both are honestly optional: a token
 * revocation is workspace-wide and belongs to no container, and a record nobody initiated
 * belongs to no principal. `null` is the answer, never an empty string.
 *
 * `payload` is the stored JSON TEXT, verbatim, and not a parsed object. Every writer supplies
 * its own shape — `{ terminalId, machineId, elementId }`, `{ subjectPrincipalId, count }` — and
 * no schema anywhere declares them, so parsing here would publish a contract the writers never
 * signed and would make one malformed row poison a whole page. The text is exactly what
 * happened; deciding what it means is the reader's.
 *
 * THE FIVE TRACE FIELDS (axiom A6, ADR 0018) are the same row wearing its other family's
 * clothes. A trace is an event row whose `type` is `trace`, carrying the attribution of one
 * exercise of authority at a door: `door` names the action, `authority` the capability set
 * discharged (or `root`, or `open` for a door that demands nothing), `targets` the
 * `manifold://` nodes the door named, `outcome` how it ended (`TRACE_OUTCOMES`), and `session`
 * the socket it arrived on — null meaning the HTTP action door. They are published nullable
 * and always present, exactly as `containerId` is, because a reader that has to distinguish
 * "absent key" from "null value" is a reader doing the row's job for it. On any event row all
 * five are null and `targets` is empty; `door` is the discriminator.
 *
 * `targets` is the one column published PARSED, and the asymmetry with `payload` is the
 * producer: `payload` has as many shapes as there are writers, while `targets` has exactly one
 * writer — the dispatch ladder, serializing formatted URIs — so an array is the honest type
 * rather than a promise nobody made.
 *
 * `outcome` is published as TEXT for the same reason `type` is — the column's vocabulary has
 * one writer and many readers, and a row from a newer server carrying a word this build has
 * never heard of must still read as a row rather than poison the page. The vocabulary itself
 * is not folklore: `TRACE_OUTCOMES` in `@manifold/protocol` is the closed set the ladder
 * writes from, so the join is typed where it is produced and published where it is consumed.
 */
export const EventRowSchema = z.strictObject({
  id: z.number().int(),
  containerId: z.string().nullable(),
  ts: z.number().int(),
  principalId: z.string().nullable(),
  type: z.string(),
  payload: z.string(),
  door: z.string().nullable(),
  authority: z.string().nullable(),
  targets: z.array(z.string()).readonly(),
  outcome: z.string().nullable(),
  session: z.string().nullable(),
});

export const EventsListResponseSchema = z.strictObject({ events: z.array(EventRowSchema) });

export type EventRow = z.infer<typeof EventRowSchema>;

export const eventsActions = [
  defineAction({
    name: "list",
    title: "List recorded events",
    /*
      ROOT ONLY, and this is a design decision rather than a conservative default.

      The events table is a WORKSPACE-WIDE trail: `container_id` scopes a row, but the rows
      themselves carry other principals' activity — who joined which container and when, whose
      terminal opened where, which principal had tokens revoked. There is no cap in the
      vocabulary that means "may read other people's history", and inventing one by reusing
      `containers:read` would silently hand every share-link holder a surveillance feed over
      the whole workspace. `*` is the honest ceiling until ADR 0011's grants can express the
      real question, and it is the one this door can be trusted with today.

      `scope: "workspace"` follows from the same fact and is left at the default: a
      container-scoped token is refused at the scope rung before the handler runs, so the
      `containerId` filter below is a NARROWING for a caller who could already see everything,
      never a way for a confined caller to reach out. That is why the handler owes
      `ctx.outsideScope` nothing — `ctx.containerScope` is null by construction here.
    */
    caps: ["*"],
    input: z.strictObject({
      limit: z.number().int().positive().max(EVENTS_LIST_MAX).optional(),
      /*
        `kind`, not `type`. The column is `type` and the row publishes it under that name
        because that is the datum's own name, but the FILTER is a question the caller asks —
        "which kind of event?" — and `kind` is the word every other filter and discriminator in
        the vocabulary uses for that question. Bounded at 64 characters because an event type
        is a short symbol every writer hardcodes, so a longer argument cannot match anything and
        has no business reaching SQLite.
      */
      kind: z.string().min(1).max(64).optional(),
      containerId: z.string().min(1).optional(),
    }),
    result: EventsListResponseSchema,
  }),
];
