import { z } from "zod";
import { AgentMessageSchema, ServerToAgentMessageSchema } from "./machine.ts";
import {
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDenialSchema,
  placementVocabulary,
} from "./placement.ts";
import { ClientMessageSchema, ServerMessageSchema } from "./session.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/**
 * Machine-legible protocol description, served at `GET /api/protocol`. Agents introspect
 * the wire format without reading source — the schemas ARE the documentation.
 *
 * `placement` publishes the composition algebra itself: which item kinds exist, the
 * groups they carry, the groups each container accepts, the guards, and the denial rules.
 * A mod discovers what composes with what — and what never can — from these tables.
 */
export function buildProtocolJsonSchema(): Record<string, unknown> {
  return {
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
    },
  };
}
