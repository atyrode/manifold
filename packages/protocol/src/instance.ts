import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { InstanceOriginSchema } from "./origin.ts";
import { PrincipalSchema } from "./principal.ts";
import { ManifoldRefSchema } from "./uri.ts";

/**
 * CROSS-INSTANCE SHARING (ADR 0014): the vocabulary two manifold instances share, and the
 * instance channel they say it over.
 *
 * Axiom A4 says a share to another instance is the same reference-and-pipe shape as any other
 * projection, and names the machine channel as the precedent it generalizes. What generalizes
 * is the DISCIPLINE, not the frames: a long-lived peer dials OUT to a server with a token, the
 * wire is version-negotiated, liveness is a ping the dialer answers, and a refusal closes with
 * a code that says which kind of refusal it was.
 *
 * TWO PLANES, and this file is only the first one:
 *
 *   CONTROL     the instance channel (`/ws/instance`) — the frames below. The GUEST instance
 *               dials the HOST, proves it holds a share, and asks for tickets. No scene bytes,
 *               no document updates, no presence, no terminal output ever cross it.
 *   PROJECTION  the host's EXISTING session channel. The guest USER's own lens dials the host
 *               with a ticket and joins the shared container's room as an ordinary participant,
 *               so the room, the document, attendance and every door are the machinery a local
 *               viewer uses (invariant 14; `AXIOMS.md` §The portable lens is what licenses a
 *               lens pointed at a second instance).
 *
 * A TICKET is therefore not a new credential kind: it is an ordinary attenuated token the host
 * mints through the ladder it already has, whose principal carries the guest's `origin`. That is
 * what makes revocation ordinary too — a revoked ticket principal is fenced by the same
 * `auth.onRevoked` fanout that closes any other revoked socket.
 */

/**
 * Where the instance channel lives. Exported because the endpoint is a JOIN between the server
 * that serves it and the SDK that dials it, and `AXIOMS.md` §Foundation law prefers a join the
 * compiler can see to a registry row policing two string literals.
 */
export const INSTANCE_CHANNEL_PATH = "/ws/instance";

// ---------------------------------------------------------------------------- shares and dials

export const ShareIdSchema = z.string().min(1).max(64);

/**
 * A SHARE, as its host records it: A5's "a minted token bound to a subtree grant" with the
 * grant's node, its capability set, and the origin of the instance it was minted FOR — a share
 * is addressed at mint, never an open bearer link (ADR 0014 §2).
 *
 * No secret and no hash appear here. The raw token is handed to the minting caller exactly once
 * (in {@link ShareGrantSchema}) and lives hashed at rest from then on, so a list door and an
 * audit view can publish the whole record without a redaction rule anybody has to remember.
 *
 * `tickets` counts the per-principal tokens minted under this share and still live. It is the
 * auditable half of "who is actually inside": a share with zero tickets is a door nobody has
 * walked through, and revoking one reports how many were severed.
 */
export const ShareSchema = z.strictObject({
  id: ShareIdSchema,
  ref: ManifoldRefSchema,
  caps: z.array(CapSchema).min(1),
  origin: InstanceOriginSchema,
  createdAt: z.number().int().nonnegative(),
  createdBy: z.string().min(1),
  revokedAt: z.number().int().nonnegative().nullable(),
  tickets: z.number().int().nonnegative(),
});
export type Share = z.infer<typeof ShareSchema>;

/**
 * A DIAL is the same relationship seen from the guest: a share this instance holds a secret
 * for, the host it lives at, and whether the pipe is currently up.
 *
 * `offline` and `revoked` are different answers and the distinction is the whole reason the
 * status is not a boolean: an unreachable host is a transport problem the dialer keeps retrying,
 * while a revoked share is a decision somebody made and re-dialing it forever would be noise.
 */
export const DIAL_STATUSES = ["live", "offline", "revoked"] as const;
export const DialStatusSchema = z.enum(DIAL_STATUSES);
export type DialStatus = z.infer<typeof DialStatusSchema>;

export const DialSchema = z.strictObject({
  id: z.string().min(1).max(64),
  origin: InstanceOriginSchema,
  /** The node's address IN THE HOST's addressing space; the pair with `origin` is the reference. */
  ref: ManifoldRefSchema,
  caps: z.array(CapSchema).min(1),
  /** What the host calls the node right now, for an index row to paint; null when unknown. */
  title: z.string().max(120).nullable(),
  status: DialStatusSchema,
  dialedAt: z.number().int().nonnegative(),
});
export type Dial = z.infer<typeof DialSchema>;

/**
 * What `core.access.listShares` answers: BOTH directions through one door, because the concept
 * is "the cross-instance relationships this instance has" and two list doors would be two
 * answers to one question (invariant 14).
 */
export const ShareInventorySchema = z.strictObject({
  shares: z.array(ShareSchema),
  dials: z.array(DialSchema),
});
export type ShareInventory = z.infer<typeof ShareInventorySchema>;

/**
 * Minting names the node by `manifold://` reference rather than by a bare container id, because
 * invariant 13 makes that form canonical for anything addressable — a grant naming a container
 * by id would be the second address system it forbids — and because ADR 0011 widens this exact
 * field to subtree grants without changing its shape.
 *
 * Only a container can be shared this wave; the door refuses any other ref form by name.
 */
export const MintShareRequestSchema = z.strictObject({
  node: ManifoldRefSchema,
  caps: z.array(CapSchema).min(1),
  /** The guest instance this share is FOR; the host records it and the handshake checks it. */
  origin: InstanceOriginSchema,
});
export type MintShareRequest = z.infer<typeof MintShareRequestSchema>;

/**
 * The raw share secret, returned exactly once to the caller who asked for it — the `TokenGrant`
 * precedent, for the same reason: the host keeps only a hash, so this is the single moment the
 * secret exists anywhere it can be copied from.
 */
export const ShareGrantSchema = z.strictObject({
  share: ShareSchema,
  token: z.string().min(1),
});
export type ShareGrant = z.infer<typeof ShareGrantSchema>;

export const RevokeShareRequestSchema = z.strictObject({ shareId: ShareIdSchema });
export type RevokeShareRequest = z.infer<typeof RevokeShareRequestSchema>;

/** Accepting a share: the host to dial, and the secret it minted. */
export const DialShareRequestSchema = z.strictObject({
  origin: InstanceOriginSchema,
  token: z.string().min(1),
});
export type DialShareRequest = z.infer<typeof DialShareRequestSchema>;

export const OpenDialRequestSchema = z.strictObject({ dialId: z.string().min(1).max(64) });
export type OpenDialRequest = z.infer<typeof OpenDialRequestSchema>;

/**
 * What a guest principal gets back when it opens a dial: where to point a lens, what it will be
 * allowed to do there, and the per-principal ticket to present. The share's own secret is NOT in
 * here and never leaves the guest instance (ADR 0014 §3).
 */
export const DialTicketSchema = z.strictObject({
  origin: InstanceOriginSchema,
  ref: ManifoldRefSchema,
  caps: z.array(CapSchema).min(1),
  token: z.string().min(1),
});
export type DialTicket = z.infer<typeof DialTicketSchema>;

// ---------------------------------------------------------------------------- channel frames

/**
 * How many ticket principals one `hello` may advertise. A guest holds one per local principal
 * that has opened the share, so the bound is a workspace's worth of people, not a fleet's.
 */
export const MAX_ADVERTISED_TICKETS = 256;

/** Correlates a `ticket_request` with its answer; guest-chosen, opaque to the host. */
const requestId = z.string().min(1).max(64);

/**
 * Why the host will not issue a ticket. A closed set, because a refusal a guest cannot classify
 * is a refusal it can only log: `share_revoked` stops the guest from asking again,
 * `invalid_principal` is a bug on the guest's side, and `unavailable` is worth retrying.
 */
export const TICKET_REFUSALS = ["share_revoked", "invalid_principal", "unavailable"] as const;
export const TicketRefusalSchema = z.enum(TICKET_REFUSALS);
export type TicketRefusal = z.infer<typeof TicketRefusalSchema>;

const GUEST_BODIES = {
  /**
   * The first frame, always. It carries the credential (the share secret), the claim (`origin`,
   * which must equal the origin the share was minted for or the host closes 4401), the software
   * version for the operator's benefit, and RESUME.
   *
   * Resume rides the hello rather than getting a frame of its own, exactly as a machine `hello`
   * advertises its retained terminals: `tickets` are the host-side principal ids this guest
   * believes it still holds tickets for, and `welcome.tickets` answers with the subset that is
   * still true. A separate resume frame would be a second reconnection mechanism for a channel
   * whose handshake already is one.
   */
  hello: z.strictObject({
    type: z.literal("hello"),
    protocolVersion: z.number().int().positive(),
    origin: InstanceOriginSchema,
    instanceVersion: z.string().min(1).max(32),
    token: z.string().min(1),
    tickets: z.array(z.string().min(1)).max(MAX_ADVERTISED_TICKETS).optional(),
  }),
  pong: z.strictObject({ type: z.literal("pong") }),
  /**
   * "This principal of mine wants in." The guest's OWN principal travels verbatim as data — the
   * host mints its own mirror id and never adopts the foreign one, because two instances' id
   * spaces are independent and trusting a claimed id would let a guest impersonate a host-local
   * principal.
   */
  ticket_request: z.strictObject({
    type: z.literal("ticket_request"),
    requestId,
    principal: PrincipalSchema,
  }),
} as const;

export const GuestMessageSchema = z.discriminatedUnion("type", [
  GUEST_BODIES.hello,
  GUEST_BODIES.pong,
  GUEST_BODIES.ticket_request,
]);
export type GuestMessage = z.infer<typeof GuestMessageSchema>;

const HOST_BODIES = {
  /**
   * The share, as the host describes it to the guest that just proved it holds it. `ref` is an
   * address in the HOST's space and `origin` says whose space that is — the pair IS the
   * cross-instance reference, because `manifold://` gains no authority component this wave
   * (ADR 0014 §6).
   */
  welcome: z.strictObject({
    type: z.literal("welcome"),
    origin: InstanceOriginSchema,
    serverEpoch: z.string().min(1),
    shareId: ShareIdSchema,
    ref: ManifoldRefSchema,
    caps: z.array(CapSchema).min(1),
    title: z.string().max(120).nullable(),
    /** Of the advertised ticket principals, the ones still live; the guest drops the rest. */
    tickets: z.array(z.string().min(1)).max(MAX_ADVERTISED_TICKETS),
  }),
  ping: z.strictObject({ type: z.literal("ping") }),
  /** An ordinary attenuated token. Its principal carries `origin` — that is the whole federation. */
  ticket: z.strictObject({
    type: z.literal("ticket"),
    requestId,
    token: z.string().min(1),
    principal: PrincipalSchema,
  }),
  ticket_error: z.strictObject({
    type: z.literal("ticket_error"),
    requestId,
    reason: TicketRefusalSchema,
  }),
} as const;

export const HostToGuestMessageSchema = z.discriminatedUnion("type", [
  HOST_BODIES.welcome,
  HOST_BODIES.ping,
  HOST_BODIES.ticket,
  HOST_BODIES.ticket_error,
]);
export type HostToGuestMessage = z.infer<typeof HostToGuestMessageSchema>;

// ---------------------------------------------------------------------------- type inventories

/**
 * Literal inventories mirroring machine.ts: frame classifiers use these so an unknown type is
 * forward-compat ignored while a malformed KNOWN type is a protocol error. Compile-time
 * exhaustive in both directions (satisfies blocks extras, Exclude blocks omissions).
 */
export const GUEST_MESSAGE_TYPES = [
  "hello",
  "pong",
  "ticket_request",
] as const satisfies readonly GuestMessage["type"][];

export const HOST_TO_GUEST_MESSAGE_TYPES = [
  "welcome",
  "ping",
  "ticket",
  "ticket_error",
] as const satisfies readonly HostToGuestMessage["type"][];

type MissingGuestType = Exclude<GuestMessage["type"], (typeof GUEST_MESSAGE_TYPES)[number]>;
type MissingHostType = Exclude<
  HostToGuestMessage["type"],
  (typeof HOST_TO_GUEST_MESSAGE_TYPES)[number]
>;
const guestInventoryComplete: MissingGuestType extends never ? true : never = true;
const hostInventoryComplete: MissingHostType extends never ? true : never = true;
void guestInventoryComplete;
void hostInventoryComplete;

/**
 * The cross-instance vocabulary, published — the counterpart of `pluginVocabulary()` and
 * `eventVocabulary()`. A stranger's instance learns the whole relationship from
 * `GET /api/protocol`: the two frame unions, what a share and a dial ARE, why a ticket is not a
 * new credential kind, and the closed refusal set.
 */
export function instanceVocabulary(): Record<string, unknown> {
  return {
    path: INSTANCE_CHANNEL_PATH,
    ticketRefusals: [...TICKET_REFUSALS],
    dialStatuses: [...DIAL_STATUSES],
    maxAdvertisedTickets: MAX_ADVERTISED_TICKETS,
    share: z.toJSONSchema(ShareSchema),
    dial: z.toJSONSchema(DialSchema),
  };
}
