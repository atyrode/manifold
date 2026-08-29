import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  AddPadTileRequestSchema,
  AddPadTileResponseSchema,
  BindTerminalRequestSchema,
  BindTerminalResponseSchema,
  BootstrapPrincipalRequestSchema,
  ComposePadTileRequestSchema,
  ComposePadTileResponseSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  EnrollMachineRequestSchema,
  ExpandTerminalResponseSchema,
  ExtractPadTileRequestSchema,
  ExtractPadTileResponseSchema,
  HealthResponseSchema,
  HttpErrorSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  MovePadTreeItemRequestSchema,
  MoveTerminalPoolRequestSchema,
  OkResponseSchema,
  PROTOCOL_VERSION,
  PadPresenceResponseSchema,
  PadTreeResponseSchema,
  PadSessionsResponseSchema,
  PadResponseSchema,
  PadsResponseSchema,
  ParkTerminalRequestSchema,
  RenamePadRequestSchema,
  RenameTerminalRequestSchema,
  RevokeRequestSchema,
  TerminalPoolResponseSchema,
  TokenGrantSchema,
  buildProtocolJsonSchema,
  type Cap,
  type HttpError,
  type Pad,
  type PadSessionSummary,
  type RuntimeDeps,
  type TerminalPoolResponse,
} from "@manifold/protocol";
import { ZodError } from "zod";
import { ServiceError, type AuthContext, type AuthService } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { MachineGateway } from "./machine-ws.ts";
import type { RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

/** Build identifier exposed by `/healthz`; protocol compatibility has its own version. */
export const SERVER_VERSION = "0.1.0";

/** HTTP JSON ceiling, mirrored by Bun.serve so chunked bodies cannot reach its 128 MiB default. */
export const MAX_HTTP_BODY_BYTES = 1_048_576;

type HttpErrorCode = HttpError["error"]["code"];

class RequestError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function parseRequest<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestError("invalid", "request did not match the protocol schema");
    }
    throw error;
  }
}

const STATUS_BY_CODE: Readonly<Record<RequestError["code"], number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  internal: 500,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: RequestError): Response {
  const body = HttpErrorSchema.parse({ error: { code: error.code, message: error.message } });
  return jsonResponse(body, STATUS_BY_CODE[error.code]);
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_HTTP_BODY_BYTES) {
    throw new RequestError("invalid", "request body is too large");
  }

  const reader = request.body?.getReader();
  if (reader === undefined) throw new RequestError("invalid", "request body must be valid JSON");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      throw new RequestError("invalid", "request body is too large");
    }
    chunks.push(chunk.value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks, bytes));
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("invalid", "request body must be valid JSON");
  }
}

function requireRoot(context: AuthContext): void {
  if (!context.isRoot) throw new RequestError("forbidden", "root capability required");
}

/** Decodes one path segment, mapping a missing or malformed escape to a 400. */
function decodePathSegment(encoded: string | undefined, label: string): string {
  if (encoded === undefined) throw new RequestError("invalid", `${label} is missing`);
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new RequestError("invalid", `${label} is invalid`);
  }
}

/** Bun fetch handler implementing the complete JSON API and SPA fallback contract. */
export class HttpApp {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly machines: MachineGateway,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
  ) {}

  /** Handles a request without allowing auth secrets to enter logs or errors. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse(
          HealthResponseSchema.parse({
            ok: true,
            version: SERVER_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            ...(this.config.build !== undefined ? { build: this.config.build } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/protocol") {
        return jsonResponse(buildProtocolJsonSchema());
      }
      if (url.pathname.startsWith("/api")) return await this.api(request, url.pathname);
      if (
        request.method === "GET" &&
        !url.pathname.startsWith("/ws") &&
        !url.pathname.startsWith("/healthz")
      ) {
        return this.staticFile(url.pathname);
      }
      throw new RequestError("not_found", "route not found");
    } catch (error) {
      if (error instanceof RequestError) return errorResponse(error);
      if (error instanceof ServiceError) {
        return errorResponse(new RequestError(error.code, error.message));
      }
      this.logger.error("http_request_failed", {
        method: request.method,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      return errorResponse(new RequestError("internal", "internal server error"));
    }
  }

  private authenticate(request: Request): AuthContext {
    const header = request.headers.get("authorization");
    if (header === null || !header.startsWith("Bearer ")) {
      throw new RequestError("unauthorized", "bearer token required");
    }
    const raw = header.slice("Bearer ".length).trim();
    if (raw.length === 0) throw new RequestError("unauthorized", "bearer token required");
    return this.auth.authenticate(raw);
  }

  private requireCap(context: AuthContext, cap: Exclude<Cap, "*">, padId?: string): void {
    if (!this.auth.allows(context, cap, padId)) {
      throw new RequestError("forbidden", `${cap} capability required`);
    }
  }

  private async api(request: Request, pathname: string): Promise<Response> {
    if (request.method === "GET" && pathname === "/api/pads") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const pads = this.store
        .listPads()
        .filter((pad) => context.padScope === null || pad.id === context.padScope);
      return jsonResponse(PadsResponseSchema.parse({ pads }));
    }
    if (pathname === "/api/pad-tree") {
      const context = this.authenticate(request);
      if (request.method === "GET") {
        this.requireCap(context, "pads:read");
        const tree = this.store.listPadTree();
        if (context.padScope === null) {
          return jsonResponse(PadTreeResponseSchema.parse({ items: tree }));
        }
        const included = new Set<string>();
        const pad = tree.find((item) => item.kind === "pad" && item.pad.id === context.padScope);
        if (pad?.kind === "pad") {
          included.add(`pad:${pad.pad.id}`);
          let parentId = pad.parentId;
          while (parentId !== null) {
            const folder = tree.find((item) => item.kind === "folder" && item.id === parentId);
            if (folder?.kind !== "folder") break;
            included.add(`folder:${folder.id}`);
            parentId = folder.parentId;
          }
        }
        return jsonResponse(
          PadTreeResponseSchema.parse({
            items: tree.filter((item) =>
              included.has(item.kind === "pad" ? `pad:${item.pad.id}` : `folder:${item.id}`),
            ),
          }),
        );
      }
      if (request.method === "PUT") {
        this.requireCap(context, "pads:write");
        if (context.padScope !== null) {
          throw new RequestError("forbidden", "scoped tokens cannot organize pads");
        }
        const input = parseRequest(MovePadTreeItemRequestSchema, await parseJsonBody(request));
        if (!this.store.movePadTreeItem(input.item, input.parentId, input.index)) {
          throw new RequestError("conflict", "sidebar tree changed while moving an item");
        }
        return jsonResponse(PadTreeResponseSchema.parse({ items: this.store.listPadTree() }));
      }
    }
    if (pathname === "/api/pad-folders" && request.method === "POST") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot create pad folders");
      }
      const input = parseRequest(CreatePadFolderRequestSchema, await parseJsonBody(request));
      if (
        !this.store.createPadFolder(
          {
            id: this.runtime.newId(),
            name: input.name,
            createdAt: this.runtime.now(),
          },
          input.parentId,
        )
      ) {
        throw new RequestError("conflict", "parent folder changed while creating a folder");
      }
      return jsonResponse(PadTreeResponseSchema.parse({ items: this.store.listPadTree() }));
    }

    const folderMatch = /^\/api\/pad-folders\/([^/]+)$/.exec(pathname);
    if (folderMatch !== null) {
      const folderId = decodePathSegment(folderMatch[1], "folder id");
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot modify pad folders");
      }
      if (request.method === "PATCH") {
        const input = parseRequest(RenamePadRequestSchema, await parseJsonBody(request));
        if (!this.store.renamePadFolder(folderId, input.name)) {
          throw new RequestError("not_found", "pad folder not found");
        }
        return jsonResponse(PadTreeResponseSchema.parse({ items: this.store.listPadTree() }));
      }
      if (request.method === "DELETE") {
        if (!this.store.deletePadFolder(folderId)) {
          throw new RequestError("not_found", "pad folder not found");
        }
        return jsonResponse(PadTreeResponseSchema.parse({ items: this.store.listPadTree() }));
      }
    }

    if (request.method === "GET" && pathname === "/api/pad-presence") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const pads = this.rooms
        .presence()
        .filter((pad) => context.padScope === null || pad.padId === context.padScope);
      return jsonResponse(PadPresenceResponseSchema.parse({ pads }));
    }
    if (request.method === "GET" && pathname === "/api/pad-sessions") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const sessions: PadSessionSummary[] = [];
      for (const session of this.store.listSessions()) {
        // Parked sessions are bound to no pad; the terminal pool route lists those.
        if (session.padId === null) continue;
        if (context.padScope !== null && session.padId !== context.padScope) continue;
        sessions.push({
          id: session.id,
          padId: session.padId,
          machineId: session.machineId,
          elementId: session.elementId,
          createdAt: session.createdAt,
          status: session.status,
          exitCode: session.exitCode,
        });
      }
      return jsonResponse(PadSessionsResponseSchema.parse({ sessions }));
    }

    if (request.method === "GET" && pathname === "/api/terminals") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot read the terminal pool");
      }
      this.broker.pruneExitedParked();
      return jsonResponse(this.terminalPoolPayload());
    }

    if (request.method === "PUT" && pathname === "/api/terminal-pool") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot reorder the terminal pool");
      }
      const input = parseRequest(MoveTerminalPoolRequestSchema, await parseJsonBody(request));
      const moved = this.broker.movePooled(input.sessionId, input.index);
      if (moved === "not_found") throw new RequestError("not_found", "terminal not found");
      if (moved === "conflict") throw new RequestError("conflict", "terminal is bound to a pad");
      return jsonResponse(this.terminalPoolPayload());
    }

    const terminalMatch = /^\/api\/terminals\/([^/]+)(\/park|\/bind|\/expand)?$/.exec(pathname);
    if (terminalMatch !== null) {
      const sessionId = decodePathSegment(terminalMatch[1], "terminal id");
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot move terminals between pads");
      }
      const action = terminalMatch[2];
      if (request.method === "POST" && action === "/park") {
        const input = parseRequest(ParkTerminalRequestSchema, await parseJsonBody(request));
        if (this.broker.park(sessionId, input.elementId) === "not_found") {
          throw new RequestError("not_found", "terminal not found");
        }
        return jsonResponse(OkResponseSchema.parse({ ok: true }));
      }
      if (request.method === "POST" && action === "/bind") {
        const input = parseRequest(BindTerminalRequestSchema, await parseJsonBody(request));
        const bound = this.broker.bind(sessionId, input.padId, input.x, input.y);
        if (bound === "not_found") throw new RequestError("not_found", "terminal not found");
        if (bound === "pad_not_found") throw new RequestError("not_found", "pad not found");
        if (bound === "already_bound") {
          throw new RequestError("conflict", "terminal is already bound to a pad");
        }
        if (bound === "conflict") {
          throw new RequestError("conflict", "container rejected the terminal placement");
        }
        return jsonResponse(BindTerminalResponseSchema.parse({ elementId: bound.elementId }));
      }
      if (request.method === "POST" && action === "/expand") {
        const expanded = this.broker.expand(sessionId);
        if (expanded === "not_found") throw new RequestError("not_found", "terminal not found");
        if (expanded === "exited") throw new RequestError("conflict", "terminal has exited");
        return jsonResponse(ExpandTerminalResponseSchema.parse({ viewId: expanded.viewId }));
      }
      if (request.method === "DELETE" && action === undefined) {
        const killed = this.broker.killById(sessionId);
        if (killed === "not_found") throw new RequestError("not_found", "terminal not found");
        if (killed === "conflict") throw new RequestError("conflict", "terminal has exited");
        return jsonResponse(OkResponseSchema.parse({ ok: true }));
      }
      if (request.method === "PATCH" && action === undefined) {
        const input = parseRequest(RenameTerminalRequestSchema, await parseJsonBody(request));
        const name = input.name.trim();
        if (name.length === 0) throw new RequestError("invalid", "name is empty");
        if (this.broker.rename(sessionId, name) === "not_found") {
          throw new RequestError("not_found", "terminal not found");
        }
        return jsonResponse(OkResponseSchema.parse({ ok: true }));
      }
    }

    if (request.method === "POST" && pathname === "/api/pads") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot create pads");
      }
      const input = parseRequest(CreatePadRequestSchema, await parseJsonBody(request));
      const pad: Pad = {
        id: this.runtime.newId(),
        name: input.name,
        createdAt: this.runtime.now(),
        // An explicit creation is always durable: only an expand births a bubble.
        layout: input.layout ?? "canvas",
        transient: false,
      };
      this.store.createPad(pad);
      return jsonResponse(PadResponseSchema.parse({ pad }));
    }

    const padMatch = /^\/api\/pads\/([^/]+)$/.exec(pathname);
    if (padMatch !== null) {
      const padId = decodePathSegment(padMatch[1], "pad id");
      const context = this.authenticate(request);
      if (request.method === "GET") {
        this.requireCap(context, "pads:read", padId);
        const pad = this.store.getPad(padId);
        if (pad === null) throw new RequestError("not_found", "pad not found");
        return jsonResponse(PadResponseSchema.parse({ pad }));
      }
      if (request.method === "PATCH") {
        this.requireCap(context, "pads:write", padId);
        const input = parseRequest(RenamePadRequestSchema, await parseJsonBody(request));
        const renamed = this.store.renamePad(padId, input.name);
        if (renamed === null) throw new RequestError("not_found", "pad not found");
        // Naming a container claims it: a named view is never popped by a bubble rule.
        this.broker.harden(padId);
        const pad = this.store.getPad(padId);
        if (pad === null) throw new RequestError("not_found", "pad not found");
        return jsonResponse(PadResponseSchema.parse({ pad }));
      }
      if (request.method === "DELETE") {
        requireRoot(context);
        if (this.store.getPad(padId) === null) {
          throw new RequestError("not_found", "pad not found");
        }
        this.broker.dropPad(padId);
        this.rooms.drop(padId);
        this.store.deletePad(padId);
        return jsonResponse(OkResponseSchema.parse({ ok: true }));
      }
    }

    const containerMatch = /^\/api\/pads\/([^/]+)\/(pin|tiles|compose)$/.exec(pathname);
    const tileMatch = /^\/api\/pads\/([^/]+)\/tiles\/([^/]+)(\/extract)?$/.exec(pathname);
    if (containerMatch !== null || tileMatch !== null) {
      const padId = decodePathSegment((containerMatch ?? tileMatch)?.[1], "pad id");
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot recompose containers");
      }
      if (containerMatch !== null && request.method === "POST") {
        const action = containerMatch[2];
        if (action === "pin") {
          if (this.broker.harden(padId) === "not_found") {
            throw new RequestError("not_found", "pad not found");
          }
          return jsonResponse(OkResponseSchema.parse({ ok: true }));
        }
        if (action === "tiles") {
          const input = parseRequest(AddPadTileRequestSchema, await parseJsonBody(request));
          const added = this.broker.addTile(padId, input.surface, input.targetTileId, input.edge);
          if (added === "not_found") throw new RequestError("not_found", "surface not found");
          if (added === "conflict") {
            throw new RequestError("conflict", "surface cannot be tiled into this container");
          }
          return jsonResponse(AddPadTileResponseSchema.parse({ tileId: added.tileId }));
        }
        const input = parseRequest(ComposePadTileRequestSchema, await parseJsonBody(request));
        const composed = this.broker.composeOnCanvas(
          padId,
          input.targetElementId,
          input.surface,
          input.edge,
        );
        if (composed === "not_found") throw new RequestError("not_found", "surface not found");
        if (composed === "conflict") {
          throw new RequestError("conflict", "surfaces cannot be composed on this canvas");
        }
        return jsonResponse(ComposePadTileResponseSchema.parse({ viewId: composed.viewId }));
      }
      if (tileMatch !== null) {
        const tileId = decodePathSegment(tileMatch[2], "tile id");
        if (request.method === "DELETE" && tileMatch[3] === undefined) {
          const removed = this.broker.removeTile(padId, tileId);
          if (removed === "not_found") throw new RequestError("not_found", "tile not found");
          if (removed === "conflict") throw new RequestError("conflict", "tile is not removable");
          return jsonResponse(OkResponseSchema.parse({ ok: true }));
        }
        if (request.method === "POST" && tileMatch[3] === "/extract") {
          const input = parseRequest(ExtractPadTileRequestSchema, await parseJsonBody(request));
          const extracted = this.broker.extractTile(padId, tileId, input.x, input.y);
          if (extracted === "not_found") throw new RequestError("not_found", "tile not found");
          if (extracted === "conflict") {
            throw new RequestError("conflict", "tile cannot be extracted onto a canvas");
          }
          return jsonResponse(
            ExtractPadTileResponseSchema.parse({ elementId: extracted.elementId }),
          );
        }
      }
    }

    if (request.method === "POST" && pathname === "/api/principals") {
      const context = this.authenticate(request);
      requireRoot(context);
      const input = parseRequest(BootstrapPrincipalRequestSchema, await parseJsonBody(request));
      return jsonResponse(TokenGrantSchema.parse(this.auth.bootstrapPrincipal(input, context)));
    }

    if (request.method === "POST" && pathname === "/api/tokens") {
      const context = this.authenticate(request);
      const input = parseRequest(MintTokenRequestSchema, await parseJsonBody(request));
      return jsonResponse(TokenGrantSchema.parse(this.auth.mintToken(input, context)));
    }

    if (request.method === "POST" && pathname === "/api/tokens/revoke") {
      const context = this.authenticate(request);
      const input = parseRequest(RevokeRequestSchema, await parseJsonBody(request));
      this.auth.revokePrincipal(input.principalId, context);
      return jsonResponse(OkResponseSchema.parse({ ok: true }));
    }

    if (request.method === "POST" && pathname === "/api/machines") {
      const context = this.authenticate(request);
      this.requireCap(context, "machines:mint");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot enroll machines");
      }
      const input = parseRequest(EnrollMachineRequestSchema, await parseJsonBody(request));
      // Idempotent re-enroll (issue #40): an existing name returns its row without minting,
      // so a re-run provision flow never invalidates the token a running agent holds.
      // `rotateToken` is the explicit recovery path for a lost token file.
      const existing = this.store.getMachineByName(input.name);
      if (existing !== null && input.rotateToken !== true) {
        return jsonResponse(
          MachineEnrollResponseSchema.parse({
            machine: { id: existing.id, name: existing.name },
          }),
        );
      }
      const enrolled =
        existing === null
          ? this.auth.enrollMachine(input.name, context)
          : this.auth.rotateMachineToken(existing, context.principal.id);
      return jsonResponse(
        MachineEnrollResponseSchema.parse({
          machine: { id: enrolled.machine.id, name: enrolled.machine.name },
          machineToken: enrolled.machineToken,
        }),
      );
    }

    if (request.method === "GET" && pathname === "/api/machines") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const machines = this.store.listMachines().map((machine) => ({
        id: machine.id,
        name: machine.name,
        online: this.machines.isOnline(machine.id),
      }));
      return jsonResponse(MachinesResponseSchema.parse({ machines }));
    }

    if (request.method === "GET" && pathname === "/api/introspect") {
      const context = this.authenticate(request);
      requireRoot(context);
      return jsonResponse({
        rooms: this.rooms.introspect(),
        sessions: this.broker.introspect(),
        machines: this.store.listMachines().map((machine) => ({
          id: machine.id,
          name: machine.name,
          online: this.machines.isOnline(machine.id),
          lastSeen: machine.lastSeen,
        })),
        principals: this.store.listPrincipals(),
      });
    }

    throw new RequestError("not_found", "route not found");
  }

  /**
   * Canonical terminal-pool payload. Positions are reported as the index in the canonical
   * order rather than the stored value, so a client can move an entry to a returned index
   * even while some rows still carry the pre-#57 null position.
   */
  private terminalPoolPayload(): TerminalPoolResponse {
    const terminals = this.store.listParkedSessions().map((session, position) => ({
      id: session.id,
      machineId: session.machineId,
      name: session.name,
      createdAt: session.createdAt,
      status: session.status,
      exitCode: session.exitCode,
      sortOrder: position,
    }));
    return TerminalPoolResponseSchema.parse({ terminals });
  }

  private staticFile(pathname: string): Response {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new RequestError("invalid", "path is invalid");
    }
    const candidate = resolve(this.config.webDist, `.${decoded}`);
    const distPrefix = `${resolve(this.config.webDist)}${sep}`;
    if (candidate.startsWith(distPrefix)) {
      try {
        if (statSync(candidate).isFile()) return new Response(Bun.file(candidate));
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
      }
    }
    const index = resolve(this.config.webDist, "index.html");
    try {
      if (statSync(index).isFile()) return new Response(Bun.file(index));
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
    }
    throw new RequestError("not_found", "web application is not built");
  }
}
