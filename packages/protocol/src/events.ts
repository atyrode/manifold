import { z } from "zod";
import { boundedPayloadSchema } from "./elements.ts";
import { ManifoldRefSchema, formatManifoldUri, type ManifoldRef } from "./uri.ts";

/**
 * THE EVENT VOCABULARY (ADR 0012): what a notification IS, independent of the socket that
 * carries it. The frames live in `session.ts` beside every other session frame; the words
 * they are built from live here, because the plugin MANIFEST declares them too
 * (`contributes.events`) and a manifest may not import a wire frame to learn what an event
 * kind is.
 *
 * Three rules the shapes below enforce rather than describe:
 *
 *   A TOPIC IS A NODE. There is no topic namespace and no wildcard grammar: a topic is a
 *   {@link ManifoldRefSchema}, the same address the resolve door consumes, so subscribing is a
 *   read-grant question against an existing node rather than a second authorization
 *   vocabulary. Nothing here mints a topic STRING — the ref travels structured, and
 *   `formatManifoldUri` is the one joiner any registry keys itself by. A namespace joined at
 *   runtime needs a registry (`REGISTRY.md` §Runtime-joined namespaces); a namespace that
 *   cannot be typed as a string on the wire needs none, which is why this is the cheaper half
 *   of that law rather than an exemption from it.
 *
 *   AN EVENT NEVER MUTATES. The payload is a bounded flat record — the same discipline an
 *   element payload rides — and there is deliberately no correlation id, no reply topic and no
 *   response frame. A plugin that wants to DO something in response calls an action, which
 *   goes through the door that performs the authority check.
 *
 *   THE VOCABULARY IS DECLARED, NOT INVENTED. A kind is a manifest contribution; the assembly
 *   indexes it and refuses an emission whose kind nobody declared (@manifold/plugin's
 *   `emitterMayEmit`). So the set of kinds a live workspace can emit is closed and published,
 *   while the set a build can DECLARE stays open.
 */

/**
 * How long a kind may be. Longer than a plugin's LOCAL name bound (32) on purpose: a kind is
 * snake_case and spends a character on every word boundary where a local name spends none, and
 * the vocabulary the tree already stores needs three words (`terminal_controller_changed`).
 * Far short of the 128 an address segment carries, because a kind is a word, not an id.
 */
export const MAX_EVENT_KIND_LENGTH = 48;

/**
 * WHAT HAPPENED, as one snake_case word run: `terminal_exited`, `machine_online`,
 * `container_created`.
 *
 * snake_case rather than the manifest's own `LOCAL_NAME_PATTERN` (which admits interior
 * capitals and hyphens but no underscore) because this vocabulary is not new — the durable
 * history in the `events` table has spelled these `terminal_opened`, `principal_joined`,
 * `token_minted` since long before the plane existed, and `terminal_event.kind` spells its
 * closed set the same way. One concept, one spelling, across the wire, the manifest and the
 * audit log; the alternative was a wire kind that differed from the stored kind of the same
 * event by a punctuation mark, which is the §Lexicon failure with extra steps.
 *
 * A kind is GLOBAL and claimed by exactly one plugin at assembly (D5), so it is never
 * qualified by its owner's id: `terminal_exited` says what happened, and the topic says to
 * whom. Prefixing the owner would make a subscriber's match depend on which plugin currently
 * implements a concept.
 */
export const EVENT_KIND_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export const EventKindSchema = z.string().regex(EVENT_KIND_PATTERN).max(MAX_EVENT_KIND_LENGTH);
export type EventKind = z.infer<typeof EventKindSchema>;

/**
 * What an event may CARRY beside its topic and its kind: the element payload's discipline
 * verbatim (`boundedPayloadSchema`), flat and bounded in the same three dimensions.
 *
 * It is deliberately not a second, looser shape. A notification whose payload could nest would
 * become the cheapest way to ship state — and a receiver acting on shipped state instead of
 * reading it back through a door is how a notification plane turns into a replication plane
 * nobody arbitrates. The payload exists so a subscriber can decide whether to re-read, not so
 * it can skip the read.
 */
export const EventPayloadSchema = boundedPayloadSchema("event");
export type EventPayload = z.infer<typeof EventPayloadSchema>;

/**
 * How many topics one `subscribe`/`unsubscribe` frame may name. A client subscribes to what it
 * is rendering, and a frame naming more nodes than a screen can hold is a client that has
 * confused a subscription for a query; exceeding it is a MALFORMED frame, which the session
 * grammar already answers with 4002 rather than with a new refusal vocabulary.
 */
export const MAX_SUBSCRIBE_TOPICS = 64;

/**
 * How many topics one CONNECTION may hold at once. Subscriptions are presence-class state —
 * they die with the socket and are never persisted — so the bound protects the server's fan-out
 * index, not a durable table. Past it the server keeps the subscriptions it has and drops the
 * excess with a log line: closing a whole tab because one panel over-subscribed is exactly the
 * blast radius multiplexing exists to remove.
 */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 256;

/**
 * Whether an event on `topic` reaches a subscriber that named `subscribed`.
 *
 * SELF, plus the ONE hop the addressing grammar itself states: an element and a tile have no
 * identity outside their container and are ADDRESSED through it (`uri.ts`), so a subscription
 * to a container hears what happens to its own leaves. Nothing else nests — a terminal, a
 * principal, a plugin and an action are all roots — so this relation is total over the seven
 * forms and needs no store to answer.
 *
 * That last property is the reason it lives here rather than in the server: the SAME rule
 * decides which sockets a fan-out reaches and which handler an SDK hands the frame to, and a
 * rule that needed a database lookup could only ever be evaluated on one side. A subscriber
 * that saw the server deliver an event no client-side rule could route would be watching
 * frames vanish. Authority is a different question, asked with the store in hand at both the
 * subscribe and the delivery door, and it can only ever narrow this.
 */
export function topicMatches(subscribed: ManifoldRef, topic: ManifoldRef): boolean {
  if (
    subscribed.kind === "container" &&
    (topic.kind === "element" || topic.kind === "tile" || topic.kind === "container")
  ) {
    return topic.containerId === subscribed.containerId;
  }
  return formatManifoldUri(subscribed) === formatManifoldUri(topic);
}

/**
 * The event vocabulary, published — the counterpart of `pluginVocabulary()` and
 * `placementVocabulary()`. A stranger's agent reading `GET /api/protocol` learns what a topic
 * is (the address grammar, not a string convention), how a kind is spelled, what a payload may
 * carry and what a socket may hold, from the declarations themselves.
 *
 * WHICH kinds a given server can emit is not here: that is the live assembly, and it is
 * already published on every roster row's `contributes.events`. This package describes shapes
 * and never their inhabitants.
 */
export function eventVocabulary(): Record<string, unknown> {
  return {
    kindPattern: EVENT_KIND_PATTERN.source,
    maxKindLength: MAX_EVENT_KIND_LENGTH,
    maxTopicsPerFrame: MAX_SUBSCRIBE_TOPICS,
    maxSubscriptionsPerConnection: MAX_SUBSCRIPTIONS_PER_CONNECTION,
    topic: z.toJSONSchema(ManifoldRefSchema),
    kind: z.toJSONSchema(EventKindSchema),
    payload: z.toJSONSchema(EventPayloadSchema),
  };
}
