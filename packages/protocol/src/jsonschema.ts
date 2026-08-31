import { z } from "zod";
import { AgentMessageSchema, ServerToAgentMessageSchema } from "./machine.ts";
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
  };
  if (extras === undefined) return description;
  description["actions"] = extras.actions;
  description["plugins"] = extras.plugins;
  return description;
}
