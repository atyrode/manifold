export { PROTOCOL_VERSION } from "./version.ts";
export { CAPS, CapSchema, hasCap, type Cap } from "./capabilities.ts";
export { PrincipalSchema, type Principal } from "./principal.ts";
export {
  MAX_ELEMENTS_PER_UPDATE,
  MAX_SESSION_FRAME_BYTES,
  SceneElementSchema,
  TerminalCustomDataSchema,
  compareElements,
  type SceneElement,
  type TerminalCustomData,
} from "./elements.ts";
export { applyAccepted, reconcile, shouldAccept, type ReconcileResult } from "./reconcile.ts";
export {
  CURSOR_MIN_INTERVAL_MS,
  VIEWPORT_MIN_INTERVAL_MS,
  CursorSchema,
  PresencePayloadSchema,
  PresenceStateSchema,
  PresenceStatusSchema,
  type Cursor,
  type PresencePayload,
  type PresenceState,
  type PresenceStatus,
} from "./presence.ts";
export {
  CLIENT_MESSAGE_TYPES,
  ClientMessageSchema,
  SERVER_MESSAGE_TYPES,
  ErrorCodeSchema,
  ServerMessageSchema,
  SessionInfoSchema,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type SessionInfo,
} from "./session.ts";
export {
  AdvertisedSessionSchema,
  AgentMessageSchema,
  ServerToAgentMessageSchema,
  type AdvertisedSession,
  type AgentMessage,
  type ServerToAgentMessage,
} from "./machine.ts";
export {
  BootstrapPrincipalRequestSchema,
  CreatePadRequestSchema,
  HttpErrorSchema,
  MintTokenRequestSchema,
  PadSchema,
  RevokeRequestSchema,
  TokenGrantSchema,
  type BootstrapPrincipalRequest,
  type HttpError,
  type MintTokenRequest,
  type Pad,
  type TokenGrant,
} from "./http.ts";
export { defaultRuntime, type RuntimeDeps } from "./runtime.ts";
export { buildProtocolJsonSchema } from "./jsonschema.ts";
export {
  HealthResponseSchema,
  MachineEnrollResponseSchema,
  MachineSummarySchema,
  MachinesResponseSchema,
  OkResponseSchema,
  PadResponseSchema,
  PadsResponseSchema,
} from "./http.ts";
