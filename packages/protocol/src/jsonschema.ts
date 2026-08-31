import { z } from "zod";
import { AgentMessageSchema, ServerToAgentMessageSchema } from "./machine.ts";
import {
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDenialSchema,
  placementVocabulary,
} from "./placement.ts";
import type { ActionSummary, PluginRoster } from "./plugin.ts";
import { ClientMessageSchema, ServerMessageSchema } from "./session.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/**
 * The live composition, when the caller has one to publish. The protocol package describes
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
 * `placement` publishes the composition algebra itself: which item kinds exist, the
 * groups they carry, the groups each container accepts, the guards, and the denial rules.
 * A mod discovers what composes with what — and what never can — from these tables.
 *
 * `extras` publishes the ACTION vocabulary and the plugin roster the same way: a stranger's
 * agent learns every door it may knock on, and what each one takes, from this one document.
 * Omitting it yields exactly the pre-plugin description, so a caller with no composition in
 * hand (a test, a schema dump) is not obliged to invent one.
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
    },
  };
  if (extras === undefined) return description;
  description["actions"] = extras.actions;
  description["plugins"] = extras.plugins;
  return description;
}
