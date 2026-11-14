import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  CONNECTION_BODIES,
  ContainerResponseSchema,
  PluginReceiptsResponseSchema,
  PluginsResponseSchema,
  TokenGrantV2Schema,
  formatManifoldUri,
  type AuthorityScope,
  type PluginManifest,
} from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { sha256Hex } from "../src/stores.ts";

/*
  THE DISCOVERY DOORS, each under its own rule (#402, #430), over a real server and real
  credentials: public discovery is an allowlist every authenticated reader shares, private
  receipts need `plugins:read`, verified installed code needs `plugins:load`, and the caller's
  own layout needs `layouts:read`. A valid credential lacking the capability is refused
  separately from an unknown (401) or revoked (403) one.
*/

const OWNER_KEY = "f".repeat(64);
const ID = "vendor.discovery";
const WEB = "export const panel = 'discovery';";
const SHEET = ".plugin-vendor_discovery { color: rgb(1, 2, 3) }";

const running: RunningServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const manifest: PluginManifest = {
  id: ID,
  version: "1.0.0",
  title: "Discovery",
  description: "Disposable discovery-authority fixture",
  capabilities: ["containers:read"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { web: "web.js", styles: true },
};

test("each discovery door names its own capability and receipts never reach public discovery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-discovery-"));
  directories.push(cwd);
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const uploads = join(config.dataDir, PLUGIN_UPLOADS_DIR);
  mkdirSync(uploads, { recursive: true });
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      hardenedContract: 2,
      manifest,
      files: {
        "web.js": Buffer.from(WEB).toString("base64"),
        "styles.css": Buffer.from(SHEET).toString("base64"),
      },
    }),
  );
  const source = join(uploads, "discovery.manifold-plugin.json");
  writeFileSync(source, bytes);
  const sha256 = sha256Hex(bytes);
  const server = await startServer({ config, logger: silentLogger, announce: false });
  running.push(server);

  const get = (path: string, token?: string) =>
    fetch(`${server.publicUrl}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  const owner = async (name: string, body: unknown): Promise<unknown> => {
    const outcome = ActionOutcomeSchema.parse(
      await (
        await fetch(`${server.publicUrl}/api/actions/${name}`, {
          method: "POST",
          headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json(),
    );
    if (!outcome.ok) throw new Error(outcome.denial.message);
    return outcome.result;
  };
  const mint = async (name: string, scope: AuthorityScope, containerId?: string) =>
    TokenGrantV2Schema.parse(
      await owner("core.access.mintTokenV2", {
        principal: { name, kind: "human" },
        scope,
        ...(containerId === undefined ? {} : { containerId }),
        expiresAt: Date.now() + 10 * 60_000,
      }),
    );
  const workspace = (...caps: AuthorityScope[number]["caps"]): AuthorityScope => [
    { target: "manifold://", reach: "subtree", caps },
  ];

  await owner("engine.plugins.install", { source, sha256 });
  await owner("engine.plugins.setEnabled", { id: ID, enabled: false });
  await owner("engine.plugins.setEnabled", { id: ID, enabled: true });
  const { container } = ContainerResponseSchema.parse(
    await owner("core.index.createContainer", { name: "scoped" }),
  );

  const reader = await mint("reader", workspace("containers:read"));
  const loader = await mint("loader", workspace("plugins:load"));
  const inspector = await mint("inspector", workspace("plugins:read"));
  const arranger = await mint("arranger", workspace("layouts:read"));
  const scoped = await mint(
    "scoped inspector",
    [
      {
        target: formatManifoldUri({ kind: "container", containerId: container.id }),
        reach: "subtree",
        caps: ["containers:read", "plugins:read"],
      },
    ],
    container.id,
  );

  // The private half: `plugins:read` on an unscoped credential, and nobody else.
  const receiptsDoor = "/api/plugins/receipts";
  expect((await get(receiptsDoor)).status).toBe(401);
  const refusedReceipts = await get(receiptsDoor, reader.token);
  expect(refusedReceipts.status).toBe(403);
  expect(await refusedReceipts.json()).toEqual({
    error: { code: "forbidden", message: "plugins:read capability required" },
  });
  expect((await get(receiptsDoor, scoped.token)).status).toBe(403);
  const receipts = PluginReceiptsResponseSchema.parse(
    await (await get(receiptsDoor, inspector.token)).json(),
  ).receipts;
  const receipt = receipts.find((entry) => entry.id === ID);
  expect(receipt?.install).toMatchObject({ sha256, source, grantedCaps: ["containers:read"] });
  const installedBy = receipt?.install?.installedBy;
  const changedBy = receipt?.changedBy;
  if (typeof installedBy !== "string" || typeof changedBy !== "string")
    throw new Error("the receipt must attribute the install and the toggle");

  // Public discovery: the same allowlist anonymously and to any valid credential, carrying the
  // pin a loader keys on and no value the receipt holds (its SHAPE stays published vocabulary).
  const anonymous = await (await get("/api/protocol")).text();
  expect((await get("/api/plugins")).status).toBe(401);
  expect((await get("/api/plugins", "not-a-credential")).status).toBe(401);
  for (const token of [loader.token, scoped.token]) {
    const response = await get("/api/plugins", token);
    expect(response.status).toBe(200);
    const text = await response.text();
    const row = PluginsResponseSchema.parse(JSON.parse(text)).plugins.find(
      (entry) => entry.manifest.id === ID,
    );
    expect(row?.install).toEqual({ sha256 });
    expect(row).not.toHaveProperty("changedBy");
    for (const document of [text, anonymous]) {
      expect(document).toContain(sha256);
      for (const secret of [source, installedBy, changedBy]) expect(document).not.toContain(secret);
    }
  }

  // Verified installed code and its sheet: `plugins:load`, not container viewing.
  for (const [path, body] of [
    [`/api/plugins/${ID}/web.js`, WEB],
    [`/api/plugins/${ID}/styles.css`, SHEET],
  ] as const) {
    expect((await get(path)).status).toBe(401);
    expect((await get(path, reader.token)).status).toBe(403);
    const served = await get(path, loader.token);
    expect(served.status).toBe(200);
    expect(served.headers.get("etag")).toBe(`"${sha256}"`);
    expect(await served.text()).toBe(body);
  }

  // The caller's own layout: `layouts:read`, answered for the authenticated principal only.
  expect((await get("/api/layout", reader.token)).status).toBe(403);
  expect((await get("/api/layout", arranger.token)).status).toBe(200);

  // A recognised but revoked credential is refused as such at every door.
  for (const principalId of [loader.principal.id, arranger.principal.id])
    await owner("core.access.revoke", { principalId });
  expect((await get("/api/plugins", loader.token)).status).toBe(403);
  expect((await get(`/api/plugins/${ID}/web.js`, loader.token)).status).toBe(403);
  expect((await get("/api/layout", arranger.token)).status).toBe(403);
}, 30_000);

test("a session socket hears only the public roster before admission and closes on an unknown first frame", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-discovery-ws-"));
  directories.push(cwd);
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const server = await startServer({ config, logger: silentLogger, announce: false });
  running.push(server);
  const socket = new WebSocket(`${server.publicUrl.replace(/^http/, "ws")}/ws/session`);
  const frames: string[] = [];
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  socket.addEventListener("message", (event) => {
    frames.push(String(event.data));
    if (frames.length === 2) socket.send(JSON.stringify({ type: "from_a_later_client" }));
  });
  socket.addEventListener("close", (event) => {
    closed.resolve({ code: event.code, reason: event.reason });
  });
  expect(await closed.promise).toEqual({
    code: 4002,
    reason: "first frame must be join or observe",
  });
  const plugins = CONNECTION_BODIES.plugins.parse(JSON.parse(frames[1]!));
  expect(plugins.roster.length).toBeGreaterThan(0);
  for (const row of plugins.roster) expect(row).not.toHaveProperty("changedBy");
}, 30_000);
