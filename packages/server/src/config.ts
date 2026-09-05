import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBuildIdentity, type BuildIdentity } from "../../../scripts/build-identity.ts";
import { normalizeInstanceOrigin } from "@manifold/protocol";

const HEX_64 = /^[0-9a-f]{64}$/i;

/** Fully resolved server configuration. Mutable `publicUrl` is finalized after port 0 binds. */
export interface ServerConfig {
  port: number;
  hostname: string;
  dataDir: string;
  ownerKey: string;
  publicUrl: string;
  publicUrlExplicit: boolean;
  webDist: string;
  spawnAgent: boolean;
  localMachineName: string;
  /** Opt-in (`MANIFOLD_ANNOUNCE_KEY=1`): embed `#key=` in the boot announce. Off by default so the owner key never enters log streams. */
  announceKey: boolean;
  /**
   * Opt-in (`MANIFOLD_PLUGIN_DEV_PATHS=1`): `engine.plugins.install` accepts an absolute path
   * anywhere on this host, not only under `<data>/plugin-uploads/`. Development only.
   */
  pluginDevPaths: boolean;
  /**
   * What this process is, as `/healthz` reports it: `MANIFOLD_VERSION`, `MANIFOLD_BUILD` and
   * `MANIFOLD_CHANNEL` when the deployment says, derived from the checkout's git tags otherwise
   * (`scripts/build-identity.ts`).
   */
  identity: BuildIdentity;
  /** Optional production instance trusted to admit browser identities into this instance. */
  previewIdentityAuthority: string | null;
  /** Optional DNS suffix whose integrated and numbered previews this instance may authorize. */
  previewDomain: string | null;
  /** Instance-local Ed25519 issuer key; the private half never leaves this process. */
  previewIdentityPrivateKey: string;
  previewIdentityPublicKey: string;
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

function normalizePreviewDomain(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    domain.length === 0 ||
    domain.includes("/") ||
    domain.includes(":") ||
    !/^[a-z0-9.-]+$/.test(domain)
  ) {
    throw new Error("MANIFOLD_PREVIEW_DOMAIN must be a DNS name without a scheme or path");
  }
  return domain;
}

function normalizeIdentityAuthority(value: string): string {
  const authority = normalizeInstanceOrigin(value);
  if (authority === null) {
    throw new Error("MANIFOLD_IDENTITY_AUTHORITY must be an absolute instance origin");
  }
  const url = new URL(authority);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname.endsWith(".localhost"));
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("MANIFOLD_IDENTITY_AUTHORITY must use https outside localhost");
  }
  return authority;
}

function loadPreviewIdentityKey(dataDir: string): {
  privateKey: string;
  publicKey: string;
} {
  const path = resolve(dataDir, "preview-identity.key");
  let privateKey: string;
  try {
    privateKey = readFileSync(path, "utf8");
    chmodSync(path, 0o600);
    createPrivateKey(privateKey);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") !== "ENOENT") throw error;
    const generated = generateKeyPairSync("ed25519");
    privateKey = generated.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    try {
      writeFileSync(path, privateKey, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (!(writeError instanceof Error) || Reflect.get(writeError, "code") !== "EEXIST") {
        throw writeError;
      }
      privateKey = readFileSync(path, "utf8");
    }
    chmodSync(path, 0o600);
  }
  const publicKey = createPublicKey(createPrivateKey(privateKey))
    .export({ format: "pem", type: "spki" })
    .toString();
  return { privateKey, publicKey };
}

/** Loads runtime env, creates the data directory, and materializes the 0600 owner key. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const port = parsePort(env.MANIFOLD_PORT);
  const configuredBind = env.MANIFOLD_BIND;
  const hostname = configuredBind?.trim() ?? "127.0.0.1";
  if (hostname.length === 0) throw new Error("MANIFOLD_BIND must not be empty");
  const dataDir = resolve(cwd, env.MANIFOLD_DATA_DIR ?? "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const explicit = env.MANIFOLD_PUBLIC_URL !== undefined;
  const publicUrl = normalizePublicUrl(env.MANIFOLD_PUBLIC_URL ?? `http://localhost:${port}`);
  const localMachineName = (env.MANIFOLD_MACHINE_NAME ?? "local").trim();
  if (localMachineName.length === 0) throw new Error("MANIFOLD_MACHINE_NAME must not be empty");
  const configuredIdentityAuthority = env.MANIFOLD_IDENTITY_AUTHORITY?.trim();
  const previewIdentityAuthority =
    configuredIdentityAuthority === undefined || configuredIdentityAuthority === ""
      ? null
      : normalizeIdentityAuthority(configuredIdentityAuthority);
  const previewDomain = normalizePreviewDomain(env.MANIFOLD_PREVIEW_DOMAIN);
  const previewIdentityKey = loadPreviewIdentityKey(dataDir);
  return {
    port,
    hostname,
    dataDir,
    ownerKey: loadOwnerKey(dataDir, env.MANIFOLD_OWNER_KEY),
    publicUrl,
    publicUrlExplicit: explicit,
    webDist: resolve(cwd, env.MANIFOLD_WEB_DIST ?? "packages/web/dist"),
    spawnAgent: env.MANIFOLD_SPAWN_AGENT !== "0",
    localMachineName,
    announceKey: env.MANIFOLD_ANNOUNCE_KEY === "1",
    pluginDevPaths: env.MANIFOLD_PLUGIN_DEV_PATHS === "1",
    previewIdentityAuthority,
    previewDomain,
    previewIdentityPrivateKey: previewIdentityKey.privateKey,
    previewIdentityPublicKey: previewIdentityKey.publicKey,
    identity: resolveBuildIdentity(env),
  };
}

/** Replaces the default port-0 URL once Bun reports the actual bound port. */
export function finalizePublicUrl(config: ServerConfig, boundPort: number): void {
  if (!config.publicUrlExplicit) config.publicUrl = `http://localhost:${boundPort}`;
}
