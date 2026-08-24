import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const HEX_64 = /^[0-9a-f]{64}$/i;

/** Fully resolved server configuration. Mutable `publicUrl` is finalized after port 0 binds. */
export interface ServerConfig {
  port: number;
  dataDir: string;
  ownerKey: string;
  publicUrl: string;
  publicUrlExplicit: boolean;
  webDist: string;
  spawnAgent: boolean;
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parsePort(value: string | undefined): number {
  const raw = value ?? "7777";
  if (!/^\d+$/.test(raw)) throw new Error("MANIFOLD_PORT must be an integer from 0 to 65535");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("MANIFOLD_PORT must be an integer from 0 to 65535");
  }
  return port;
}

function readOwnerKey(path: string): string {
  const key = readFileSync(path, "utf8").trim();
  if (!HEX_64.test(key)) throw new Error(`invalid owner key file: ${path}`);
  chmodSync(path, 0o600);
  return key.toLowerCase();
}

function loadOwnerKey(dataDir: string, configured: string | undefined): string {
  if (configured !== undefined) {
    const key = configured.trim();
    if (!HEX_64.test(key)) throw new Error("MANIFOLD_OWNER_KEY must be exactly 64 hex characters");
    return key.toLowerCase();
  }

  const path = resolve(dataDir, "owner.key");
  try {
    return readOwnerKey(path);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") !== "ENOENT") throw error;
  }

  const generated = randomHex(32);
  try {
    writeFileSync(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return generated;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "EEXIST") {
      return readOwnerKey(path);
    }
    throw error;
  }
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MANIFOLD_PUBLIC_URL must use http or https");
  }
  return value.replace(/\/+$/, "");
}

/** Loads runtime env, creates the data directory, and materializes the 0600 owner key. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const port = parsePort(env.MANIFOLD_PORT);
  const dataDir = resolve(cwd, env.MANIFOLD_DATA_DIR ?? "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const explicit = env.MANIFOLD_PUBLIC_URL !== undefined;
  const publicUrl = normalizePublicUrl(env.MANIFOLD_PUBLIC_URL ?? `http://localhost:${port}`);
  return {
    port,
    dataDir,
    ownerKey: loadOwnerKey(dataDir, env.MANIFOLD_OWNER_KEY),
    publicUrl,
    publicUrlExplicit: explicit,
    webDist: resolve(cwd, env.MANIFOLD_WEB_DIST ?? "packages/web/dist"),
    spawnAgent: env.MANIFOLD_SPAWN_AGENT !== "0",
  };
}

/** Replaces the default port-0 URL once Bun reports the actual bound port. */
export function finalizePublicUrl(config: ServerConfig, boundPort: number): void {
  if (!config.publicUrlExplicit) config.publicUrl = `http://localhost:${boundPort}`;
}
