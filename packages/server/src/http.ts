import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  BootstrapPrincipalRequestSchema,
  CreatePadRequestSchema,
  HealthResponseSchema,
  HttpErrorSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  OkResponseSchema,
  PROTOCOL_VERSION,
  PadResponseSchema,
  PadsResponseSchema,
  RevokeRequestSchema,
  TokenGrantSchema,
  VmSessionResponseSchema,
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
import { sha256Hex, type ServerStore } from "./stores.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

/** Build identifier exposed by `/healthz`; protocol compatibility has its own version. */
export const SERVER_VERSION = "0.1.0";

/** HTTP JSON ceiling, mirrored by Bun.serve so chunked bodies cannot reach its 128 MiB default. */
export const MAX_HTTP_BODY_BYTES = 1_048_576;
const VM_SESSION_COOKIE = "manifold_vm_session";
const VM_SESSION_TTL_MS = 60 * 60 * 1_000;

interface VmSession {
  readonly expiresAt: number;
  readonly sourceTokenId: string | null;
}

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
function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function requireRoot(context: AuthContext): void {
  if (!context.isRoot) throw new RequestError("forbidden", "root capability required");
}

/** Bun fetch handler implementing the complete JSON API and SPA fallback contract. */
export class HttpApp {
  private readonly vmSessions = new Map<string, VmSession>();

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
  private pruneVmSessions(): void {
    const now = this.runtime.now();
    for (const [hash, session] of this.vmSessions) {
      if (session.expiresAt <= now) this.vmSessions.delete(hash);
    }
  }

  private issueVmSession(context: AuthContext): Response {
    requireRoot(context);
    this.pruneVmSessions();
    const raw = randomSecret();
    const expiresAt = this.runtime.now() + VM_SESSION_TTL_MS;
    this.vmSessions.set(sha256Hex(raw), {
      expiresAt,
      sourceTokenId: context.tokenId,
    });

    const publicOrigin = new URL(this.config.publicUrl);
    const attributes = [
      `${VM_SESSION_COOKIE}=${raw}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(VM_SESSION_TTL_MS / 1_000)}`,
    ];
    if (publicOrigin.protocol === "https:") attributes.push("Secure");
    if (
      publicOrigin.hostname !== "localhost" &&
      publicOrigin.hostname !== "127.0.0.1" &&
      publicOrigin.hostname !== "::1"
    ) {
      attributes.push(`Domain=${publicOrigin.hostname}`);
    }

    const response = jsonResponse(VmSessionResponseSchema.parse({ expiresAt }));
    response.headers.set("set-cookie", attributes.join("; "));
    return response;
  }

  private authorizeVm(request: Request): Response {
    const raw = readCookie(request, VM_SESSION_COOKIE);
    if (raw === null) throw new RequestError("unauthorized", "VM session required");
    const hash = sha256Hex(raw);
    const session = this.vmSessions.get(hash);
    if (session === undefined || session.expiresAt <= this.runtime.now()) {
      this.vmSessions.delete(hash);
      throw new RequestError("unauthorized", "VM session required");
    }
    if (session.sourceTokenId !== null) {
      const source = this.store.getToken(session.sourceTokenId);
      if (source === null || source.revokedAt !== null) {
        this.vmSessions.delete(hash);
        throw new RequestError("unauthorized", "VM session required");
      }
    }
    return new Response(null, { status: 204 });
  }

  private async api(request: Request, pathname: string): Promise<Response> {
    if (request.method === "POST" && pathname === "/api/vm/session") {
      return this.issueVmSession(this.authenticate(request));
    }

    if (request.method === "GET" && pathname === "/api/vm/authorize") {
      return this.authorizeVm(request);
    }

    if (request.method === "GET" && pathname === "/api/pads") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const pads = this.store
        .listPads()
        .filter((pad) => context.padScope === null || pad.id === context.padScope);
      return jsonResponse(PadsResponseSchema.parse({ pads }));
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
