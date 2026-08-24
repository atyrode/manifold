import { z } from "zod";
import { AgentMessageSchema, ServerToAgentMessageSchema } from "./machine.ts";
import { ClientMessageSchema, ServerMessageSchema } from "./session.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/**
 * Machine-legible protocol description, served at `GET /api/protocol`. Agents introspect
 * the wire format without reading source — the schemas ARE the documentation.
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
  };
}
