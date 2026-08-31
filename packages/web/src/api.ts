import {
  ActionOutcomeSchema,
  BootstrapPrincipalRequestSchema,
  HttpErrorSchema,
  LayoutResponseSchema,
  MachinesResponseSchema,
  PadPresenceResponseSchema,
  PadSchema,
  TokenGrantSchema,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type Principal,
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

/**
 * Exchanges the fragment-delivered owner key for a durable human token
 * (`core.access.createPrincipal`).
 *
 * The owner key is the ONE credential that lives outside the token system, which is why
 * this boot path holds a raw secret and no session: it authenticates as root, asks the
 * access door for an identity, and keeps only the grant. It is also why `core.access` is not
 * `essential` — disabling it costs delegation, never the owner's own way in.
 */
export async function createPrincipal(
  ownerKey: string,
  input: { readonly name: string; readonly color: string },
): Promise<StoredIdentity> {
  const request = BootstrapPrincipalRequestSchema.parse({
    name: input.name,
    color: input.color,
    kind: "human",
  });
  const grant = TokenGrantSchema.parse(
    await dispatchAction(ownerKey, "core.access.createPrincipal", request),
  );
  return { token: grant.token, principal: grant.principal };
}

/**
 * Loads one container so a direct `/p/:id` deep-link still has its name and discipline
 * (`core.views.pad`). Declared `scope: "pad"`, so a pad-scoped viewer resolves its own
 * container exactly as `GET /api/pads/:id` let it.
 */
export async function getPad(token: string, padId: string): Promise<Pad> {
  const result = await dispatchAction(token, "core.views.pad", { padId });
  return PadSchema.parse(fieldFromObject(result, "pad"));
}

/**
 * Renames a container (`core.views.renamePad`). The action is declared `scope: "pad"`, so a
 * pad-scoped token may rename the container it is scoped to and is refused for any other —
 * exactly what `PATCH /api/pads/:id` authorized before the index owned its own doors.
 */
export async function renamePad(token: string, padId: string, name: string): Promise<Pad> {
  const result = await dispatchAction(token, "core.views.renamePad", { padId, name });
  return PadSchema.parse(fieldFromObject(result, "pad"));
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

/*
 * Terminals had three bespoke routes wrapped here — the index, the rename and the kill. All
 * three are the action door now (`core.terminals.list` / `.rename` / `.kill`), reached
 * through `SessionClient` by every caller, so there is nothing left for this layer to wrap:
 * one door, and the shell reaches it exactly the way a plugin does.
 */

/**
 * One action dispatch over this device's token. The action door answers 200 for a REFUSAL
 * too, so the outcome decides and not the status; a denial becomes the thrown message every
 * other call in this layer already throws, because these callers render an error string and
 * have no rung to branch on. Code holding a `SessionClient` uses `client.action` instead —
 * this exists for the boot-time paths that hold a token and nothing else.
 */
async function dispatchAction(token: string, name: string, args: unknown): Promise<unknown> {
  const body = await requestJson(`/api/actions/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(args),
  });
  const outcome = ActionOutcomeSchema.parse(body);
  if (!outcome.ok) throw new Error(outcome.denial.message);
  return outcome.result;
}

/** The enrolled machines with live online state (`core.machines.list`). */
export async function getMachines(token: string): Promise<readonly MachineSummary[]> {
  const outcome = await dispatchAction(token, "core.machines.list", {});
  return MachinesResponseSchema.parse(outcome).machines;
}

/** Retires a container (`core.views.deletePad`); the door enforces root authority. */
export async function deletePad(token: string, padId: string): Promise<void> {
  await dispatchAction(token, "core.views.deletePad", { padId });
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
