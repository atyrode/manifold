import { z } from "zod";
import { AUTH_REFUSALS, CredentialSchema } from "./http.ts";
import { AgentMessageSchema, ServerToAgentMessageSchema } from "./machine.ts";
import { GuestMessageSchema, HostToGuestMessageSchema, instanceVocabulary } from "./instance.ts";
import { eventVocabulary } from "./events.ts";
import { grantVocabulary } from "./grants.ts";
import {
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDenialSchema,
  PlacementTraitsSchema,
  placementVocabulary,
} from "./placement.ts";
import { pluginVocabulary, type ActionSummary, type PluginRoster } from "./plugin.ts";
import { ClientMessageSchema, ServerMessageSchema } from "./session.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/**
 * The live assembly, when the caller has one to publish. The protocol package describes
 * the WIRE and knows nothing about which plugins a given server composed, so the server
 * hands its vocabulary in rather than this file reaching for a registry it cannot see.
 */
export interface ProtocolExtras {
  /** Every composed action, with its declared caps and its input/result JSON Schemas. */
  readonly actions: readonly ActionSummary[];
  readonly plugins: PluginRoster;
}

/**
 * Machine-legible protocol description, served at `GET /api/protocol`. Agents introspect
 * the wire format without reading source — the schemas ARE the documentation.
 *
 * `placement` publishes the placement algebra itself: which item kinds exist, the
 * groups they carry, the groups each container accepts, the guards, and the denial rules.
 * A mod discovers what composes with what — and what never can — from these tables.
 *
 * `pluginContract` publishes the plugin vocabulary the same way: what a manifest may
 * declare (including an element kind's placement traits), what a roster row can say, and
 * every closed set a refusal can name. It describes the SHAPE of a plugin; the `plugins`
 * key below describes the ones this server actually composed.
 *
 * `eventContract` publishes the event plane (ADR 0012): that a topic IS a node address
 * rather than a string convention, how a kind is spelled, what a payload may carry, and what
 * one socket may hold. WHICH kinds this server can emit is not repeated here — every roster
 * row already carries its own `contributes.events`, and a second copy of a live index is a
 * second thing to keep true.
 *
 * `grantContract` publishes the authority model (ADR 0011, axiom A5): what a grant row is, the
 * two closed pairs — `effect` and `reach` — a row must decide with no default available, and
 * what the three administration doors take and answer. WHICH rows a given workspace holds is
 * not here for the same reason: a table an administrator can read at
 * `core.access.listGrants` is one this document would only be able to hold stale.
 *
 * `extras` publishes the LIVE assembly — the ACTION vocabulary and the plugin roster
 * this server actually composed: a stranger's agent learns every door it may knock on, and
 * what each one takes, from this one document. Omitting it yields exactly the description
 * of a server with nothing assembled, so a caller with no assembly in hand (a test, a
 * schema dump) is not obliged to invent one.
 */
export function buildProtocolJsonSchema(extras?: ProtocolExtras): Record<string, unknown> {
  const description: Record<string, unknown> = {
    protocolVersion: PROTOCOL_VERSION,
    session: {
      client: z.toJSONSchema(ClientMessageSchema),
      server: z.toJSONSchema(ServerMessageSchema),
    },
    machine: {
      agent: z.toJSONSchema(AgentMessageSchema),
      server: z.toJSONSchema(ServerToAgentMessageSchema),
    },
    /**
     * The third wire (ADR 0014): the instance channel a guest dials a host over. Published
     * beside the other two because a stranger's INSTANCE is as much an integrator as a
     * stranger's agent — it has to learn the handshake, the ticket exchange and the closed
     * refusal set from a document rather than from this source tree.
     */
    instance: {
      ...instanceVocabulary(),
      guest: z.toJSONSchema(GuestMessageSchema),
      host: z.toJSONSchema(HostToGuestMessageSchema),
    },
    placement: {
      ...placementVocabulary(),
      request: z.toJSONSchema(PlaceRequestSchema),
      response: z.toJSONSchema(PlaceResponseSchema),
      denial: z.toJSONSchema(PlacementDenialSchema),
      /**
       * The shape a contributed element kind declares itself with (G1): the same three
       * fields `items` above is a table of, so a mod reads one description and knows both
       * what the shipped kinds are and how to state a new one.
       */
      traits: z.toJSONSchema(PlacementTraitsSchema),
    },
    pluginContract: pluginVocabulary(),
    eventContract: eventVocabulary(),
    grantContract: grantVocabulary(),
    /**
     * The CREDENTIAL vocabulary (ADR 0019): the closed set of words a refused credential
     * can be refused with, and what one live credential looks like when the list door
     * publishes it. Published for the same reason `instance.ticketRefusals` is — a
     * stranger's agent has to learn "come back with a fresh credential" from a document
     * rather than by pattern-matching prose — and it is the whole of what this file has to
     * say about identity: WHO may open which door is the roster's `actions`, and the
     * mechanism that decides it is deliberately not on the wire at all.
     */
    identity: {
      authRefusals: [...AUTH_REFUSALS],
      credential: z.toJSONSchema(CredentialSchema),
    },
  };
  if (extras === undefined) return description;
  description["actions"] = extras.actions;
  description["plugins"] = extras.plugins;
  return description;
}
