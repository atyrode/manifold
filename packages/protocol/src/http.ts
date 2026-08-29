import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { ContainerLayoutSchema, TileEdgeSchema, TileSurfaceSchema } from "./layout.ts";
import { PrincipalSchema } from "./principal.ts";

/** REST surface schemas. Auth: `Authorization: Bearer <token-or-owner-key>`. */

export const PadSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  createdAt: z.number().int().nonnegative(),
  /** Container discipline: a free canvas of elements, or a tiled view of surfaces. */
  layout: ContainerLayoutSchema,
  /** A bubble: unsplit, unpinned, and dissolved when its last occupant leaves. */
  transient: z.boolean(),
});
export type Pad = z.infer<typeof PadSchema>;

export const HttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["unauthorized", "forbidden", "not_found", "invalid", "conflict", "internal"]),
    message: z.string(),
  }),
});
export type HttpError = z.infer<typeof HttpErrorSchema>;

export const CreatePadRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  /** Omitted means `"canvas"`; explicit creations are never transient. */
  layout: ContainerLayoutSchema.optional(),
});
export const RenamePadRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
export const TreeParentIdSchema = z.string().min(1).nullable();
export const PadTreeItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pad"),
    pad: PadSchema,
    parentId: TreeParentIdSchema,
    sortOrder: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("folder"),
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    createdAt: z.number().int().nonnegative(),
    parentId: TreeParentIdSchema,
    sortOrder: z.number().int().nonnegative(),
  }),
]);
export type PadTreeItem = z.infer<typeof PadTreeItemSchema>;
export const CreatePadFolderRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  parentId: TreeParentIdSchema.default(null),
});
export const MovePadTreeItemRequestSchema = z.strictObject({
  item: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pad"), id: z.string().min(1) }),
    z.strictObject({ kind: z.literal("folder"), id: z.string().min(1) }),
  ]),
  parentId: TreeParentIdSchema,
  index: z.number().int().nonnegative(),
});

export const BootstrapPrincipalRequestSchema = z.strictObject({
  name: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  kind: z.enum(["human", "agent"]).default("human"),
});
export type BootstrapPrincipalRequest = z.infer<typeof BootstrapPrincipalRequestSchema>;

export const MintTokenRequestSchema = z
  .strictObject({
    /** Either reuse an existing principal or create one inline. */
    principalId: z.string().min(1).optional(),
    principal: BootstrapPrincipalRequestSchema.optional(),
    caps: z.array(CapSchema).min(1),
    padId: z.string().min(1).optional(),
  })
  .refine((v) => (v.principalId === undefined) !== (v.principal === undefined), {
    message: "exactly one of principalId | principal is required",
  });
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;

export const TokenGrantSchema = z.strictObject({
  token: z.string().min(1),
  principal: PrincipalSchema,
  caps: z.array(CapSchema).min(1),
  padId: z.string().nullable(),
});
export type TokenGrant = z.infer<typeof TokenGrantSchema>;

export const RevokeRequestSchema = z.strictObject({
  principalId: z.string().min(1),
});

// ---------------------------------------------------------------------------- responses

/** Exact response envelopes; servers MUST return these shapes, clients parse with them. */
export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  /** Image/tree provenance (git SHA) baked at build time; absent on ad-hoc dev runs. */
  build: z.string().min(1).optional(),
});

export const OkResponseSchema = z.strictObject({ ok: z.literal(true) });

export const PadResponseSchema = z.strictObject({ pad: PadSchema });
export const PadsResponseSchema = z.strictObject({ pads: z.array(PadSchema) });
export const PadPresenceSchema = z.strictObject({
  padId: z.string().min(1),
  principals: z.array(PrincipalSchema),
});
export type PadPresence = z.infer<typeof PadPresenceSchema>;
export const PadPresenceResponseSchema = z.strictObject({
  pads: z.array(PadPresenceSchema),
});
export const PadTreeResponseSchema = z.strictObject({ items: z.array(PadTreeItemSchema) });

export const PadSessionSummarySchema = z.strictObject({
  id: z.string().min(1),
  padId: z.string().min(1),
  machineId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
});
export type PadSessionSummary = z.infer<typeof PadSessionSummarySchema>;
export const PadSessionsResponseSchema = z.strictObject({
  sessions: z.array(PadSessionSummarySchema),
});

/** A parked terminal in the workspace pool: a live session with no pad binding. */
export const TerminalPoolEntrySchema = z.strictObject({
  id: z.string().min(1),
  machineId: z.string().min(1),
  name: z.string().min(1).max(120).nullable(),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  /** Durable pool position; contiguous 0..n-1 in the response order. */
  sortOrder: z.number().int(),
});
export type TerminalPoolEntry = z.infer<typeof TerminalPoolEntrySchema>;
export const TerminalPoolResponseSchema = z.strictObject({
  terminals: z.array(TerminalPoolEntrySchema),
});
export type TerminalPoolResponse = z.infer<typeof TerminalPoolResponseSchema>;

/** Park: remove one canvas element; unbinds the session when it was the last reference. */
export const ParkTerminalRequestSchema = z.strictObject({
  elementId: z.string().min(1),
});
export type ParkTerminalRequest = z.infer<typeof ParkTerminalRequestSchema>;

/** Bind: attach a parked session to a pad; the server authors the canvas element. */
export const BindTerminalRequestSchema = z.strictObject({
  padId: z.string().min(1),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});
export type BindTerminalRequest = z.infer<typeof BindTerminalRequestSchema>;
export const BindTerminalResponseSchema = z.strictObject({
  elementId: z.string().min(1),
});
export type BindTerminalResponse = z.infer<typeof BindTerminalResponseSchema>;

/** Rename: set a terminal's display name (works for bound and parked sessions). */
export const RenameTerminalRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
export type RenameTerminalRequest = z.infer<typeof RenameTerminalRequestSchema>;

/** Move: reorder a parked terminal within the workspace pool. */
export const MoveTerminalPoolRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  index: z.number().int().nonnegative(),
});
export type MoveTerminalPoolRequest = z.infer<typeof MoveTerminalPoolRequestSchema>;

/**
 * Expand: transmute a terminal into a tiled view born around it. The response is the
 * new container's id — the client navigates into it, and its canvas element becomes a
 * portal onto the same container.
 */
export const ExpandTerminalResponseSchema = z.strictObject({
  viewId: z.string().min(1),
});
export type ExpandTerminalResponse = z.infer<typeof ExpandTerminalResponseSchema>;

/**
 * Add a tile to a tiled container. A null `targetTileId` fills the first empty leaf,
 * else splits the root; a null `edge` fills an empty target leaf, else splits it.
 */
export const AddPadTileRequestSchema = z.strictObject({
  surface: TileSurfaceSchema,
  targetTileId: z.string().min(1).nullable(),
  edge: TileEdgeSchema.nullable(),
});
export type AddPadTileRequest = z.infer<typeof AddPadTileRequestSchema>;
export const AddPadTileResponseSchema = z.strictObject({
  tileId: z.string().min(1),
});
export type AddPadTileResponse = z.infer<typeof AddPadTileResponseSchema>;

/**
 * Compose: drop a surface onto a canvas terminal, birthing a durable view around it.
 * Dropping onto a portal adds a tile to the container it points at instead.
 */
export const ComposePadTileRequestSchema = z.strictObject({
  targetElementId: z.string().min(1),
  surface: TileSurfaceSchema,
  edge: TileEdgeSchema,
});
export type ComposePadTileRequest = z.infer<typeof ComposePadTileRequestSchema>;
export const ComposePadTileResponseSchema = z.strictObject({
  viewId: z.string().min(1),
});
export type ComposePadTileResponse = z.infer<typeof ComposePadTileResponseSchema>;

/** Extract: pull one tile out of a view back onto its canvas as a plain element. */
export const ExtractPadTileRequestSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type ExtractPadTileRequest = z.infer<typeof ExtractPadTileRequestSchema>;
export const ExtractPadTileResponseSchema = z.strictObject({
  elementId: z.string().min(1),
});
export type ExtractPadTileResponse = z.infer<typeof ExtractPadTileResponseSchema>;

export const MachineSummarySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  online: z.boolean(),
});
export type MachineSummary = z.infer<typeof MachineSummarySchema>;
export const MachinesResponseSchema = z.strictObject({
  machines: z.array(MachineSummarySchema),
});
export const EnrollMachineRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  /** Revoke and re-mint the token when the name is already enrolled (recovers a lost token file). */
  rotateToken: z.boolean().optional(),
});
export const MachineEnrollResponseSchema = z.strictObject({
  machine: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
  /**
   * Raw token — returned exactly once, only when a token was minted (new machine or explicit
   * rotation); the DB keeps only its hash. Absent on an idempotent re-enroll of an existing
   * name, which never invalidates the token the running agent already holds.
   */
  machineToken: z.string().min(1).optional(),
});
