import {
  BootstrapPrincipalRequestSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  HttpErrorSchema,
  LayoutResponseSchema,
  MachinesResponseSchema,
  PadPresenceResponseSchema,
  PadSchema,
  PadTreeResponseSchema,
  RenamePadRequestSchema,
  TerminalsResponseSchema,
  TokenGrantSchema,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PadTreeItem,
  type Principal,
  type TerminalSummary,
  type TileLayout,
} from "@manifold/protocol";

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

/** Loads one container so a direct `/p/:id` deep-link still has its name and discipline. */
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

/**
 * The CALLER's workspace tree (`GET /api/layout`) — the tile layout whose leaves name
 * plugin panels. Self-scoped by construction: the door takes no principal id and answers
 * the caller's own tree, falling back server-side to the engine's default workspace.
 */
export async function getWorkspaceLayout(token: string): Promise<TileLayout> {
  const body = await requestJson("/api/layout", {
    headers: authHeaders(token, false),
  });
  return LayoutResponseSchema.parse(body).layout;
}

/** Loads principal-level presence for pads with connected viewers. */
export async function getPadPresence(token: string): Promise<readonly PadPresence[]> {
  const body = await requestJson("/api/pad-presence", {
    headers: authHeaders(token, false),
  });
  return PadPresenceResponseSchema.parse(body).pads;
}

/**
 * Every terminal in the workspace (`GET /api/terminals`). There is no pool and no parked
 * variant: each row carries the composition it lives in (`homeId`) and whether anything
 * references that home (`unplaced`), which is what puts it at the index's top level.
 */
export async function listTerminals(token: string): Promise<readonly TerminalSummary[]> {
  const body = await requestJson("/api/terminals", {
    headers: authHeaders(token, false),
  });
  return TerminalsResponseSchema.parse(body).terminals;
}

/*
 * The terminal lifecycle used to be two bespoke routes wrapped here. Both are now the action
 * door (`core.terminals.rename` / `core.terminals.kill`) and every caller invokes it through
 * `SessionClient.action`, which is the one door plugin code and a stranger's agent share — so
 * there is nothing left for this layer to wrap.
 */

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

/*
 * Two calls retired with the solo-composition cutover and left no successor here.
 * `expandTerminal` had nothing to create — every terminal already lives in a composition,
 * so entering one is `navigate("/p/" + homeId)`. `pinPad` had nothing to claim once no
 * container dissolved under anybody. Reordering an unplaced terminal is `movePadTreeItem`
 * on its home, because the pool's separate ordering folded into the one index.
 */

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
