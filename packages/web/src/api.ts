import {
  BootstrapPrincipalRequestSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  ExpandTerminalResponseSchema,
  HttpErrorSchema,
  MachinesResponseSchema,
  MovePadTreeItemRequestSchema,
  MoveTerminalPoolRequestSchema,
  PadPresenceResponseSchema,
  PadSchema,
  PadSessionsResponseSchema,
  PadTreeResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDeniedResponseSchema,
  RenamePadRequestSchema,
  RenameTerminalRequestSchema,
  TerminalPoolResponseSchema,
  TokenGrantSchema,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PadSessionSummary,
  type PadTreeItem,
  type PlacementDestination,
  type PlacementSurface,
  type Principal,
  type TerminalPoolEntry,
} from "@manifold/protocol";
import type { PlaceOutcome } from "@manifold/sdk";

/** The browser persists only the bearer token and stable identity it needs after bootstrap. */
export interface StoredIdentity {
  readonly token: string;
  readonly principal: Principal;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (${response.status})`);
  }
}

function errorFromBody(status: number, body: unknown): Error {
  const parsed = HttpErrorSchema.safeParse(body);
  if (parsed.success) return new Error(parsed.data.error.message);
  return new Error(`Request failed (${status})`);
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body = await readBody(response);
  if (!response.ok) throw errorFromBody(response.status, body);
  return body;
}

function fieldFromObject(body: unknown, field: string): unknown {
  if (body === null || typeof body !== "object") {
    throw new Error("Server returned an invalid response");
  }
  return Reflect.get(body, field);
}

function authHeaders(token: string, includeJson: boolean): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

/** Exchanges the fragment-delivered owner key for a durable human token. */
export async function createPrincipal(
  ownerKey: string,
  input: { readonly name: string; readonly color: string },
): Promise<StoredIdentity> {
  const request = BootstrapPrincipalRequestSchema.parse({
    name: input.name,
    color: input.color,
    kind: "human",
  });
  const body = await requestJson("/api/principals", {
    method: "POST",
    headers: authHeaders(ownerKey, true),
    body: JSON.stringify(request),
  });
  const grant = TokenGrantSchema.parse(body);
  return { token: grant.token, principal: grant.principal };
}

/** Loads every pad visible to the current principal. */
export async function listPads(token: string): Promise<Pad[]> {
  const body = await requestJson("/api/pads", {
    headers: authHeaders(token, false),
  });
  const pads = fieldFromObject(body, "pads");
  if (!Array.isArray(pads)) throw new Error("Server returned an invalid pad list");
  return pads.map((pad) => PadSchema.parse(pad));
}

/** Loads a pad so direct `/p/:padId` navigation still has its display name. */
export async function getPad(token: string, padId: string): Promise<Pad> {
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}`, {
    headers: authHeaders(token, false),
  });
  return PadSchema.parse(fieldFromObject(body, "pad"));
}

/** Creates a pad through the protocol-owned request schema; `layout` picks the discipline. */
export async function createPad(token: string, name: string, layout?: Pad["layout"]): Promise<Pad> {
  const request = CreatePadRequestSchema.parse({ name, layout });
  const body = await requestJson("/api/pads", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadSchema.parse(fieldFromObject(body, "pad"));
}

/** Renames a pad through the protocol-owned request schema. */
export async function renamePad(token: string, padId: string, name: string): Promise<Pad> {
  const request = RenamePadRequestSchema.parse({ name });
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadSchema.parse(fieldFromObject(body, "pad"));
}
export async function listPadTree(token: string): Promise<readonly PadTreeItem[]> {
  const body = await requestJson("/api/pad-tree", {
    headers: authHeaders(token, false),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function createPadFolder(
  token: string,
  name: string,
  parentId: string | null,
): Promise<readonly PadTreeItem[]> {
  const request = CreatePadFolderRequestSchema.parse({ name, parentId });
  const body = await requestJson("/api/pad-folders", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function renamePadFolder(
  token: string,
  folderId: string,
  name: string,
): Promise<readonly PadTreeItem[]> {
  const request = RenamePadRequestSchema.parse({ name });
  const body = await requestJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function deletePadFolder(
  token: string,
  folderId: string,
): Promise<readonly PadTreeItem[]> {
  const body = await requestJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function movePadTreeItem(
  token: string,
  item: { readonly kind: "pad" | "folder"; readonly id: string },
  parentId: string | null,
  index: number,
): Promise<readonly PadTreeItem[]> {
  const request = MovePadTreeItemRequestSchema.parse({ item, parentId, index });
  const body = await requestJson("/api/pad-tree", {
    method: "PUT",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadTreeResponseSchema.parse(body).items;
}

/** Loads principal-level presence for pads with connected viewers. */
export async function getPadPresence(token: string): Promise<readonly PadPresence[]> {
  const body = await requestJson("/api/pad-presence", {
    headers: authHeaders(token, false),
  });
  return PadPresenceResponseSchema.parse(body).pads;
}
/** Loads open terminal sessions across every pad visible to the current principal. */
export async function getPadSessions(token: string): Promise<readonly PadSessionSummary[]> {
  const body = await requestJson("/api/pad-sessions", {
    headers: authHeaders(token, false),
  });
  return PadSessionsResponseSchema.parse(body).sessions;
}

/** Lists parked terminals in the workspace pool (`GET /api/terminals`). */
export async function listTerminals(token: string): Promise<readonly TerminalPoolEntry[]> {
  const body = await requestJson("/api/terminals", {
    headers: authHeaders(token, false),
  });
  return TerminalPoolResponseSchema.parse(body).terminals;
}

/**
 * THE placement call for anything outside a room: put an item in a container
 * (`POST /api/place`). One envelope replaces bind, park, add-tile, compose and extract,
 * and a refusal comes back as DATA — the declared rule that refused it — because a client
 * renders the rule rather than parsing prose.
 *
 * The sidebar has no room socket (it indexes containers, it does not join them), so this
 * token-bound path exists beside `SessionClient.place`, which is the same request made from
 * inside a room. Both hit the one endpoint.
 */
export async function placeItem(
  token: string,
  surface: PlacementSurface,
  destination: PlacementDestination,
): Promise<PlaceOutcome> {
  const request = PlaceRequestSchema.parse({ surface, destination });
  const response = await fetch("/api/place", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  const body = await readBody(response);
  if (response.ok) return { ok: true, result: PlaceResponseSchema.parse(body) };
  const denied = PlacementDeniedResponseSchema.safeParse(body);
  if (denied.success) return { ok: false, denial: denied.data.error.denial };
  throw errorFromBody(response.status, body);
}

/** Renames a terminal session (`PATCH /api/terminals/:id`); works bound or parked. */
export async function renameTerminal(
  token: string,
  sessionId: string,
  name: string,
): Promise<void> {
  const request = RenameTerminalRequestSchema.parse({ name });
  await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
}

/** Reorders a parked terminal within the workspace pool (`PUT /api/terminal-pool`). */
export async function moveTerminalPool(
  token: string,
  sessionId: string,
  index: number,
): Promise<readonly TerminalPoolEntry[]> {
  const request = MoveTerminalPoolRequestSchema.parse({ sessionId, index });
  const body = await requestJson("/api/terminal-pool", {
    method: "PUT",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return TerminalPoolResponseSchema.parse(body).terminals;
}

/** Kills a pooled terminal's PTY (`DELETE /api/terminals/:id`). */
export async function killPooledTerminal(token: string, sessionId: string): Promise<void> {
  await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
}

/** Loads the enrolled machines with live online state (`GET /api/machines`). */
export async function getMachines(token: string): Promise<readonly MachineSummary[]> {
  const body = await requestJson("/api/machines", {
    headers: authHeaders(token, false),
  });
  return MachinesResponseSchema.parse(body).machines;
}

/** Deletes a pad (server enforces root authority); resolves when the server confirms. */
export async function deletePad(token: string, padId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
}

/**
 * Expands a terminal into a tiled view born around it (`POST /api/terminals/:id/expand`).
 * Returns the new container id; the caller navigates into it.
 */
export async function expandTerminal(token: string, sessionId: string): Promise<string> {
  const body = await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}/expand`, {
    method: "POST",
    headers: authHeaders(token, false),
  });
  return ExpandTerminalResponseSchema.parse(body).viewId;
}

/** Hardens a transient view so it outlives its last occupant (`POST /api/pads/:id/pin`). */
export async function pinPad(token: string, padId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}/pin`, {
    method: "POST",
    headers: authHeaders(token, false),
  });
}

/**
 * Removes one leaf from a composition (`DELETE /api/pads/:id/tiles/:tileId`). Removal is
 * the one tile gesture that is NOT a placement — nothing accepts "nowhere" — so it keeps
 * its own route while every MOVE of a leaf's occupant goes through `placeItem`.
 */
export async function removePadTile(token: string, padId: string, tileId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}/tiles/${encodeURIComponent(tileId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
}
