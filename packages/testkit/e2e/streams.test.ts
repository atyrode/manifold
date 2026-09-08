import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StreamServerMessage } from "@manifold/protocol";
import { type SessionClient } from "@manifold/sdk";
import { z } from "zod";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import {
  connect,
  createContainer,
  mintToken,
  ownerAction,
  startServer,
  waitFor,
} from "../src/index.ts";

const EventRows = z.object({
  events: z.array(
    z.object({
      type: z.string(),
      door: z.string().nullable(),
      outcome: z.string().nullable(),
      payload: z.string(),
    }),
  ),
});

// Real isolated producer, real browser worker, one SDK session socket: no accelerated clock.
test("a declared 20fps stream runs for sixty seconds without journaling its frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifold-streams-"));
  const dist = resolveWebDist("manifold-streams-web-");
  const server = await startServer({
    env: { MANIFOLD_PLUGIN_DEV_PATHS: "1", MANIFOLD_WEB_DIST: dist.distDir },
  });
  const browser = new Browser();
  const clients: SessionClient[] = [];
  try {
    const pack = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../../plugin-kit/src/pack.ts"),
        join(import.meta.dir, "../../plugin-kit/test/fixtures/streams"),
        "--out",
        join(dir, "streams.json"),
        "--self-contained",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
      pack.exited,
    ]);
    if (exit !== 0) throw new Error(`pack failed: ${stderr}`);
    const packed = z.object({ file: z.string(), sha256: z.string() }).parse(JSON.parse(stdout));
    await ownerAction(server, "engine.plugins.install", {
      source: packed.file,
      sha256: packed.sha256,
      hardened: true,
    });
    const container = await createContainer(server, "Continuous streams");
    const viewer = await mintToken(server, {
      principal: { kind: "human", name: "Stream viewer", color: "#336699" },
      caps: ["containers:read", "containers:write"],
    });
    const reader = await mintToken(server, {
      principal: { kind: "human", name: "Stream denied", color: "#993366" },
      caps: ["containers:read"],
    });
    const sdk = await connect(server, { containerId: container.id, token: viewer.token });
    const deniedSdk = await connect(server, { containerId: container.id, token: reader.token });
    clients.push(sdk, deniedSdk);

    await browser.launch();
    await browser.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
    await browser.typeInto("#identity-name", "stream-browser");
    await browser.clickTestId("identity-enter");
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('#identity-name') === null"),
      10_000,
      50,
    );
    const startedAt = Date.now();
    const started = z
      .object({ epoch: z.string(), frames: z.literal(1200) })
      .parse(await ownerAction(server, "example.streams.start", { containerId: container.id }));
    expect(
      await browser.evaluate<boolean>(`(async () => {
      const identity = JSON.parse(localStorage.getItem("manifold.identity"));
      const headers = { Authorization: "Bearer " + identity.token, "Content-Type": "application/json" };
      const { layout } = await (await fetch("/api/layout", { headers })).json();
      layout.root.children.push("continuous-frames");
      layout.root.ratios.push(1);
      layout["continuous-frames"] = { id: "continuous-frames", dir: null, ratios: [], children: [],
        ref: { kind: "panel", panelId: "example.streams.frames" } };
      return (await (await fetch("/api/actions/core.space.setLayout", {
        method: "POST", headers, body: JSON.stringify({ layout }),
      })).json()).ok;
    })()`),
    ).toBe(true);

    const request = {
      kind: "example.streams.frames",
      node: { kind: "plugin" as const, pluginId: "example.streams" },
    };
    const stream = sdk.openStream(request);
    const messages: StreamServerMessage[] = [];
    let watermark = 0;
    const continuityErrors: string[] = [];
    stream.on((message) => {
      messages.push(message);
      if (message.type === "stream_snapshot") {
        // A reconnect snapshot is the retained window, not a delta: overlap is valid.
        for (let index = 1; index < message.frames.length; index += 1) {
          if (message.frames[index]!.seq !== message.frames[index - 1]!.seq + 1) {
            continuityErrors.push("non-contiguous snapshot");
          }
        }
        if (message.lastSeq < watermark) continuityErrors.push("snapshot watermark regressed");
        watermark = message.lastSeq;
      } else if (message.type === "stream_frame") {
        if (message.seq !== watermark + 1)
          continuityErrors.push(`live frame ${message.seq} after ${watermark}`);
        watermark = message.seq;
      }
    });
    const denied = deniedSdk.openStream(request);
    await waitFor(() => denied.status === "refused", 5_000, 20);
    expect(denied.snapshot).toBeNull();
    expect(denied.cursor).toBeUndefined();
    denied.close();

    await browser.goto(`${server.httpUrl}/p/${container.id}`);
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          "document.body.innerText.includes('Continuous stream fixture') && /Stream frame [1-9]/.test(document.body.innerText)",
        ),
      15_000,
      50,
    );
    await waitFor(() => (stream.cursor?.seq ?? 0) >= 60, 10_000, 20);
    const beforeReconnect = stream.cursor!;
    const snapshotCount = messages.filter((message) => message.type === "stream_snapshot").length;
    const transportId = sdk.transportId;
    await sdk.connect();
    expect(sdk.transportId).toBe(transportId);
    await waitFor(
      () => messages.filter((message) => message.type === "stream_snapshot").length > snapshotCount,
      5_000,
      20,
    );
    expect(stream.cursor?.epoch).toBe(beforeReconnect.epoch);
    expect(stream.cursor!.seq).toBeGreaterThanOrEqual(beforeReconnect.seq);

    const stale = sdk.openStream({ ...request, cursor: { epoch: started.epoch, seq: 0 } });
    const recovery: StreamServerMessage[] = [];
    stale.on((message) => recovery.push(message));
    await waitFor(() => stale.snapshot !== null, 5_000, 20);
    expect(
      recovery.some(
        (message) => message.type === "stream_gap" && message.fromSeq === 1 && message.toSeq > 0,
      ),
    ).toBe(true);
    expect(stale.snapshot!.frames.length).toBeLessThanOrEqual(20);
    stale.close();

    await waitFor(() => stream.status === "closed", 75_000, 20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(59_500);
    expect(stream.cursor).toEqual({ epoch: started.epoch, seq: 1200 });
    expect(continuityErrors).toEqual([]);
    expect(messages.filter((message) => message.type === "stream_gap")).toEqual([]);
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          "document.body.innerText.includes('Stream frame 1200') && document.body.innerText.includes('Stream status closed')",
        ),
      10_000,
      50,
    );
    stream.close();

    const rows = EventRows.parse(
      await ownerAction(server, "core.events.list", { limit: 500 }),
    ).events;
    expect(rows.filter((row) => row.door === "example.streams.start")).toHaveLength(3);
    expect(rows.some((row) => row.payload.includes("stream-only-ink-not-a-journal-event"))).toBe(
      false,
    );
    expect(
      rows.filter((row) => row.type.startsWith("stream_") || row.type === "example.streams.frames"),
    ).toEqual([]);
    const traces = rows.filter((row) => row.door === "example.streams.start");
    expect(traces.every((row) => row.outcome === "ok")).toBe(true);
    expect(
      traces
        .map((row) => JSON.parse(row.payload).streamLifecycle)
        .filter(Boolean)
        .sort(),
    ).toEqual(["close", "open"]);
  } finally {
    for (const client of clients) client.close();
    await browser.close();
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    dist.cleanup();
  }
}, 150_000);
