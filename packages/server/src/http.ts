import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  BootstrapPrincipalRequestSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  HealthResponseSchema,
  HttpErrorSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  MovePadRequestSchema,
  OkResponseSchema,
  PROTOCOL_VERSION,
  PadPresenceResponseSchema,
  PadFolderResponseSchema,
  PadFoldersResponseSchema,
  PadSessionsResponseSchema,
  PadResponseSchema,
  PadsResponseSchema,
  RenamePadRequestSchema,
  ReorderPadsRequestSchema,
  RevokeRequestSchema,
  TokenGrantSchema,
  buildProtocolJsonSchema,
  type Cap,
  type HttpError,
  type Pad,
  type RuntimeDeps,
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
    if (request.method === "PUT" && pathname === "/api/pads/order") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot reorder pads");
      }
      const input = parseRequest(ReorderPadsRequestSchema, await parseJsonBody(request));
      if (!this.store.reorderPads(input.padIds)) {
        throw new RequestError("conflict", "pad list changed while reordering");
      }
      return jsonResponse(OkResponseSchema.parse({ ok: true }));
    }
    if (pathname === "/api/pad-folders") {
      const context = this.authenticate(request);
      if (request.method === "GET") {
        this.requireCap(context, "pads:read");
        const folders =
          context.padScope === null
            ? this.store.listPadFolders()
            : this.store
                .listPadFolders()
                .map((folder) => ({
                  ...folder,
                  padIds: folder.padIds.filter((padId) => padId === context.padScope),
                }))
                .filter((folder) => folder.padIds.length > 0);
        return jsonResponse(PadFoldersResponseSchema.parse({ folders }));
      }
      if (request.method === "POST") {
        this.requireCap(context, "pads:write");
        if (context.padScope !== null) {
          throw new RequestError("forbidden", "scoped tokens cannot create pad folders");
        }
        const input = parseRequest(CreatePadFolderRequestSchema, await parseJsonBody(request));
        const folder = this.store.createPadFolder(
          {
            id: this.runtime.newId(),
            name: input.name,
            createdAt: this.runtime.now(),
          },
          input.padIds,
        );
        if (folder === null) {
          throw new RequestError("conflict", "folder pads changed while grouping");
        }
        return jsonResponse(PadFolderResponseSchema.parse({ folder }));
      }
    }

    const folderMatch = /^\/api\/pad-folders\/([^/]+)$/.exec(pathname);
    if (folderMatch !== null) {
      const encodedId = folderMatch[1];
      if (encodedId === undefined) throw new RequestError("invalid", "folder id is missing");
      let folderId: string;
      try {
        folderId = decodeURIComponent(encodedId);
      } catch {
        throw new RequestError("invalid", "folder id is invalid");
      }
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot modify pad folders");
      }
      if (request.method === "PATCH") {
        const input = parseRequest(RenamePadRequestSchema, await parseJsonBody(request));
        const folder = this.store.renamePadFolder(folderId, input.name);
        if (folder === null) throw new RequestError("not_found", "pad folder not found");
        return jsonResponse(PadFolderResponseSchema.parse({ folder }));
      }
      if (request.method === "DELETE") {
        if (!this.store.deletePadFolder(folderId)) {
          throw new RequestError("not_found", "pad folder not found");
        }
        return jsonResponse(OkResponseSchema.parse({ ok: true }));
      }
    }

    const movePadMatch = /^\/api\/pads\/([^/]+)\/folder$/.exec(pathname);
    if (movePadMatch !== null && request.method === "PUT") {
      const encodedId = movePadMatch[1];
      if (encodedId === undefined) throw new RequestError("invalid", "pad id is missing");
      let padId: string;
      try {
        padId = decodeURIComponent(encodedId);
      } catch {
        throw new RequestError("invalid", "pad id is invalid");
      }
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write", padId);
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot organize pads");
      }
      const input = parseRequest(MovePadRequestSchema, await parseJsonBody(request));
      if (!this.store.movePadToFolder(padId, input.folderId)) {
        throw new RequestError("not_found", "pad or folder not found");
      }
      return jsonResponse(OkResponseSchema.parse({ ok: true }));
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
      const sessions = this.store
        .listSessions()
        .filter((session) => context.padScope === null || session.padId === context.padScope)
        .map((session) => ({
          id: session.id,
          padId: session.padId,
          machineId: session.machineId,
          elementId: session.elementId,
          createdAt: session.createdAt,
          status: session.status,
          exitCode: session.exitCode,
        }));
      return jsonResponse(PadSessionsResponseSchema.parse({ sessions }));
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
      };
      this.store.createPad(pad);
      return jsonResponse(PadResponseSchema.parse({ pad }));
    }

    const padMatch = /^\/api\/pads\/([^/]+)$/.exec(pathname);
    if (padMatch !== null) {
      const encodedId = padMatch[1];
      if (encodedId === undefined) throw new RequestError("invalid", "pad id is missing");
      let padId: string;
      try {
        padId = decodeURIComponent(encodedId);
      } catch {
        throw new RequestError("invalid", "pad id is invalid");
      }
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
        const pad = this.store.renamePad(padId, input.name);
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
      const input = parseRequest(CreatePadRequestSchema, await parseJsonBody(request));
      const enrolled = this.auth.enrollMachine(input.name, context);
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
