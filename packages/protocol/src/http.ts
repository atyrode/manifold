import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { ContainerLayoutSchema } from "./layout.ts";
import { ITEM_KIND_NAMES } from "./placement.ts";
import { PrincipalSchema } from "./principal.ts";
import { ManifoldRefSchema } from "./uri.ts";

/** REST surface schemas. Auth: `Authorization: Bearer <token-or-owner-key>`. */

export const PadSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  createdAt: z.number().int().nonnegative(),
  /** Container discipline: a free canvas of elements, or a tiled composition of surfaces. */
  layout: ContainerLayoutSchema,
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
  /** Omitted means `"canvas"`. */
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

/**
 * A terminal, indexed. Every terminal lives in a composition — `homeId` — so there is no
 * "pooled" variant of this row and no pool position to carry: what used to be a workspace
 * pool with its own durable ordering is now the top level of the one index, and `unplaced`
 * says whether this terminal belongs there. `unplaced` is DERIVED (no container references
 * its home), never stored, which is why parking and unparking leave no state behind.
 */
export const TerminalSummarySchema = z.strictObject({
  id: z.string().min(1),
  machineId: z.string().min(1),
  name: z.string().min(1).max(120).nullable(),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  /** The composition this terminal lives in: solo from birth, shared once merged. */
  homeId: z.string().min(1),
  /** True while nothing references `homeId`: the terminal sits at the index's top level. */
  unplaced: z.boolean(),
});
export type TerminalSummary = z.infer<typeof TerminalSummarySchema>;
export const TerminalsResponseSchema = z.strictObject({
  terminals: z.array(TerminalSummarySchema),
});
export type TerminalsResponse = z.infer<typeof TerminalsResponseSchema>;

/** Rename: set a terminal's display name. */
export const RenameTerminalRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
export type RenameTerminalRequest = z.infer<typeof RenameTerminalRequestSchema>;

/**
 * One item a container holds, classified with the placement algebra's own vocabulary so a
 * census answer and a placement resolution can never disagree about what something is.
 * `containerId` is set when the item IS a container; `sessionId` when it is a terminal.
 */
export const CensusItemSchema = z.strictObject({
  kind: z.enum(ITEM_KIND_NAMES),
  containerId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
});
export type CensusItem = z.infer<typeof CensusItemSchema>;

/**
 * What one container holds and what it points at — the index's whole input.
 *
 * `items` are the items it holds DIRECTLY: occupied tile leaves for a composition, elements
 * for a canvas, in the container's own order. `references` is the forward edge of
 * containment; inverting it across every container yields the INDEX VISIBILITY RULE
 * directly — a container no other container references is top-level, and one with parents
 * renders as a collapsed child under each of them.
 */
export const ContainerCensusSchema = z.strictObject({
  padId: z.string().min(1),
  layout: ContainerLayoutSchema,
  items: z.array(CensusItemSchema),
  references: z.array(z.string().min(1)),
});
export type ContainerCensus = z.infer<typeof ContainerCensusSchema>;
export const ContainersResponseSchema = z.strictObject({
  containers: z.array(ContainerCensusSchema),
});
export type ContainersResponse = z.infer<typeof ContainersResponseSchema>;

/**
 * The item a container of ONE holds, else null. Exported rather than inlined because this
 * one line IS the paradigm — a composition holding a single item is that item, for chrome,
 * for merging and for the index — and three subsystems deciding it separately is exactly
 * how they would come to disagree.
 */
export function censusSolo(census: ContainerCensus): CensusItem | null {
  return census.items.length === 1 ? (census.items[0] ?? null) : null;
}

/**
 * Everything that used to be a verb here — bind, park, add-tile, compose, extract, and
 * (with the solo-composition cutover) expand and pin — is now `POST /api/place` carrying
 * `PlaceRequest`, whose legality comes from the placement declarations rather than from a
 * schema per gesture. Expand had nothing left to do once every terminal already lived in a
 * composition: entering one is navigation to something that exists. Pin had nothing left to
 * claim once no container dissolved under anybody. Only leaf REMOVAL kept its own route
 * (`DELETE /api/pads/:id/tiles/:tileId`), because removal is not a placement: it addresses
 * the leaf rather than moving its occupant anywhere.
 */
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

/**
 * `GET /api/resolve?uri=` — what a `manifold://` address points at, answered by the one
 * side that can see every node: the URI echoed back in canonical form, its structured
 * reference, whether the node exists RIGHT NOW, and its display title when it has one.
 *
 * Existence is a separate field rather than a 404 because a dead reference is a legitimate
 * answer about a live address — a link to a terminal that has since been killed resolves
 * fine and reports `exists: false`, which is what a renderer needs to say so.
 */
export const ResolveResponseSchema = z.strictObject({
  uri: z.string().min(1),
  ref: ManifoldRefSchema,
  exists: z.boolean(),
  title: z.string().nullable(),
});
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
