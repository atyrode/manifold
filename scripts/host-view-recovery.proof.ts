import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ActionOutcomeSchema } from "@manifold/protocol";
import { HostViewsSchema } from "../packages/plugins/machines/src/host-views.ts";
import {
  createContainer,
  enrollMachine,
  ownerAction,
  startAgent,
  startServer,
  type TestAgent,
  type TestServer,
} from "../packages/testkit/src/index.ts";
import { Browser } from "./cdp.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { sleep, until } from "./gate-lib.ts";

// Disposable real-hub proof, deliberately outside automatic test discovery.
// bun scripts/host-view-recovery.proof.ts /absolute/path/to/artifacts
// The supported CDP Fetch seam gates real HTTP responses, not plugin state or server writes.
// No credentials, headers, response bodies, raw process output or browser logs are persisted.
const destination = process.argv[2];
if (!destination) throw new Error("An artifact directory is required");
const artifacts = resolve(destination);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const dist = resolveWebDist("manifold-host-view-proof-web-");
const LIST = "core.machines.listHostViews";
const SET = "core.machines.setHostView";
const REMOVE = "core.machines.removeHostView";
const editor = '[data-testid="host-view-editor"]';
const save = `${editor} [data-action="${SET}"]`;
const PauseSchema = z.object({
  requestId: z.string(),
  request: z.object({ url: z.string() }),
  responseStatusCode: z.number(),
});
const ResponseBodySchema = z.object({ body: z.string(), base64Encoded: z.boolean() });
const FrameSchema = z.object({
  response: z.object({ opcode: z.number(), payloadData: z.string() }),
});
const EventSchema = z.object({
  type: z.string(),
  plugin: z.string().optional(),
  kind: z.string().optional(),
});
const ImageSchema = z.object({ data: z.string() });

interface Receipt {
  readonly mode: "native" | "packed";
  passed: boolean;
  phase: string;
  screenshots: string[];
  cleanup: { browser: boolean; agent: boolean; server: boolean; data: boolean };
}
const receipts: Receipt[] = [];

async function prove(hardened: boolean): Promise<void> {
  const mode = hardened ? "packed" : "native";
  const receipt: Receipt = {
    mode,
    passed: false,
    phase: "starting disposable fixture",
    screenshots: [],
    cleanup: { browser: false, agent: true, server: true, data: true },
  };
  receipts.push(receipt);
  const browser = new Browser();
  let hub: TestServer | undefined;
  let agent: TestAgent | undefined;
  let interception = false;
  const unsubscribe: (() => void)[] = [];
  let failedInterception = false;
  let holdReads = false;
  let holdAction = false;
  let failNextRead = false;
  let failedReads = 0;
  let reads = 0;
  const heldReads: string[] = [];
  const heldActions: string[] = [];
  const activity = { sockets: 0, closes: 0, authority: 0, events: 0 };
  const cdp = async (method: string, params: Record<string, unknown>) => {
    const result = await browser.send(method, params);
    if (result.error !== undefined) throw new Error(`CDP operation failed: ${method}`);
    return result.result;
  };
  const wait = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
    receipt.phase = label;
    await until(
      async () => {
        if (failedInterception) throw new Error("Response interception failed");
        return predicate();
      },
      10_000,
      label,
    );
  };
  const displayed = async (selector: string): Promise<boolean> =>
    browser.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(selector)})?.checkVisibility() === true`,
    );
  const click = async (selector: string, text?: string): Promise<void> => {
    const point = await browser.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(element =>
        ${JSON.stringify(text ?? null)} === null || element.textContent.trim() === ${JSON.stringify(text ?? null)});
      if (!(element instanceof HTMLElement) || element.matches(':disabled') || !element.checkVisibility()) return null;
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    assert.notEqual(point, null, "Expected an enabled grouping control");
    await cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  const screenshot = async (name: string): Promise<void> => {
    const image = ImageSchema.parse(await cdp("Page.captureScreenshot", { format: "png" }));
    const filename = `${mode}-${name}.png`;
    await Bun.write(join(artifacts, filename), Buffer.from(image.data, "base64"));
    receipt.screenshots.push(filename);
  };
  const revision = async (requestId: string): Promise<number> => {
    const body = ResponseBodySchema.parse(await cdp("Fetch.getResponseBody", { requestId }));
    const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
    const outcome = ActionOutcomeSchema.parse(JSON.parse(text));
    assert.equal(outcome.ok, true, "Held action must be successful");
    if (!outcome.ok) throw new Error("Held action was refused");
    return HostViewsSchema.parse(outcome.result).revision;
  };
  const release = async (pending: string[]): Promise<void> => {
    const requestId = pending.shift();
    if (requestId === undefined) throw new Error("No held host-view response");
    await cdp("Fetch.continueResponse", { requestId });
  };
  const values = async (): Promise<string[]> =>
    browser.evaluate<string[]>(
      `Array.from(document.querySelectorAll(${JSON.stringify(`${editor} input`)}), input => input.value)`,
    );
  const unavailable = async (): Promise<boolean> =>
    browser.evaluate<boolean>(
      '[...document.querySelectorAll("[role=status]")].some(element => element.textContent.includes("Host grouping unavailable"))',
    );
  try {
    hub = await startServer({
      ownerKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      env: {
        MANIFOLD_WEB_DIST: dist.distDir,
        MANIFOLD_HARDENED_PLUGINS: hardened ? "core.machines" : "",
      },
    });
    receipt.cleanup.server = false;
    receipt.cleanup.data = false;
    const enrollment = await enrollMachine(hub, "host-view-proof-account");
    agent = await startAgent({
      serverUrl: hub.url,
      machineToken: enrollment.machineToken,
      name: "host-view-proof-account",
    });
    receipt.cleanup.agent = false;
    const canvas = await createContainer(hub, "Host-view recovery proof", "canvas");
    const id = crypto.randomUUID();
    const initialHost = {
      id,
      name: "Original host",
      members: [{ machineId: enrollment.machineId, accountLabel: "Original account" }],
    };
    await ownerAction(hub, SET, { expectedRevision: 0, host: initialHost });
    const grouping = `[data-testid="host-view-${id}"]`;
    await browser.launch({ incognito: true });
    await cdp("Network.enable", {});
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    unsubscribe.push(
      browser.on("Network.webSocketCreated", () => {
        activity.sockets++;
      }),
      browser.on("Network.webSocketClosed", () => {
        activity.closes++;
      }),
      browser.on("Network.webSocketFrameReceived", (params) => {
        const frame = FrameSchema.safeParse(params);
        if (!frame.success || frame.data.response.opcode !== 1) return;
        let raw: unknown;
        try {
          raw = JSON.parse(frame.data.response.payloadData);
        } catch {
          return;
        }
        const event = EventSchema.safeParse(raw);
        if (!event.success) return;
        if (event.data.type === "authority_context") activity.authority++;
        if (
          event.data.type === "event" &&
          event.data.plugin === "core.machines" &&
          event.data.kind === "host_views_changed"
        )
          activity.events++;
      }),
      browser.on("Fetch.requestPaused", (params) => {
        void (async () => {
          const paused = PauseSchema.parse(params);
          const action = decodeURIComponent(
            new URL(paused.request.url).pathname.split("/").at(-1) ?? "",
          );
          if (action === LIST) {
            reads++;
            if (failNextRead) {
              failNextRead = false;
              failedReads++;
              await cdp("Fetch.failRequest", {
                requestId: paused.requestId,
                errorReason: "Failed",
              });
              return;
            }
            if (holdReads) {
              heldReads.push(paused.requestId);
              return;
            }
          }
          if (action === SET && holdAction) {
            heldActions.push(paused.requestId);
            return;
          }
          await cdp("Fetch.continueResponse", { requestId: paused.requestId });
        })().catch(() => {
          failedInterception = true;
        });
      }),
    );
    await cdp("Fetch.enable", {
      patterns: [
        {
          urlPattern: `${hub.httpUrl}/api/actions/core.machines.*HostView*`,
          requestStage: "Response",
        },
      ],
    });
    interception = true;
    await browser.goto(`${hub.httpUrl}/#key=${hub.ownerKey}`);
    await wait(() => displayed("#identity-name"), "ordinary browser sign-in");
    await browser.typeInto("#identity-name", "Host-view proof");
    await browser.clickTestId("identity-enter");
    await wait(async () => !(await displayed("#identity-name")), "signed-in browser");
    await browser.goto(`${hub.httpUrl}/p/${canvas.id}`);
    if (await displayed('button[aria-label="Expand sidebar"]'))
      await click('button[aria-label="Expand sidebar"]');
    await wait(() => displayed(grouping), "initial authoritative grouping");
    await browser.evaluate(`globalThis.__hostViewProof = {
      rail: document.querySelector('[data-testid="machines-rail"]'), resurrected: false, observer: null,
    }`);
    assert.ok(activity.sockets > 0 && activity.authority > 0, "Physical authority was observed");
    const initialReads = reads;
    await sleep(2_200);
    assert.equal(reads, initialReads, "Initial grouped view is event-only");
    if (hardened)
      assert.equal(
        await browser.evaluate<boolean>(
          "performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/core.machines/web.worker.js'))",
        ),
        true,
        "Actual packed worker loaded",
      );

    await click(`${grouping} button`, "Edit grouping");
    await wait(() => displayed(editor), "private grouping draft");
    await browser.evaluate(`document.querySelector(${JSON.stringify(`${editor} input`)}).select()`);
    await browser.typeInto(`${editor} input`, "Unsaved private draft");
    const freshHost = { ...initialHost, name: "Fresh authoritative host" };
    const previousEvents = activity.events;
    failNextRead = true;
    holdReads = true;
    await ownerAction(hub, SET, { expectedRevision: 1, host: freshHost });
    await wait(unavailable, "event read failure shown without authority loss");
    assert.equal(failedReads, 1);
    assert.equal(activity.events, previousEvents + 1);
    assert.equal(await displayed(grouping), false);
    assert.equal(await displayed(editor), false);
    assert.equal(await displayed('[aria-label="New terminal on host-view-proof-account"]'), true);
    const stableAuthority = { ...activity };
    await screenshot("unavailable");
    await wait(async () => heldReads.length === 1, "fallback read without a new event or socket");
    assert.deepEqual(activity, stableAuthority);
    assert.equal(await revision(heldReads[0]!), 2);
    assert.equal(await unavailable(), true, "Held success is not premature recovery");
    holdReads = false;
    await release(heldReads);
    await wait(async () => {
      const current = await values();
      return (
        !(await unavailable()) &&
        (await displayed(grouping)) &&
        current[0] === "Unsaved private draft"
      );
    }, "fresh grouping restored without losing draft");
    assert.deepEqual(await values(), ["Unsaved private draft", "Original account"]);
    assert.equal(
      await browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(save)}).disabled`),
      true,
      "Draft keeps its original CAS base",
    );
    assert.equal(
      await browser.evaluate<boolean>(
        'globalThis.__hostViewProof.rail === document.querySelector("[data-testid=machines-rail]")',
      ),
      true,
      "Mounted Machines rail retained",
    );
    assert.deepEqual(activity, stableAuthority);
    await screenshot("recovered-private-draft");
    const recoveredReads = reads;
    await sleep(2_200);
    assert.equal(reads, recoveredReads, "Recovery returned to event-only refresh");
    assert.deepEqual(activity, stableAuthority);

    await click(`${editor} button`, "Reload current grouping");
    await wait(async () => (await values())[0] === freshHost.name, "explicit draft reload");
    await browser.evaluate(`document.querySelector(${JSON.stringify(`${editor} input`)}).select()`);
    await browser.typeInto(`${editor} input`, "Delayed committed grouping");
    holdAction = true;
    holdReads = true;
    await click(save);
    await wait(
      async () => heldActions.length === 1 && heldReads.length === 1,
      "real commit and earlier event read held",
    );
    assert.equal(await revision(heldActions[0]!), 3);
    assert.equal(await revision(heldReads[0]!), 3);
    await ownerAction(hub, REMOVE, { expectedRevision: 3, hostId: id });
    await wait(
      async () => activity.events === stableAuthority.events + 2,
      "newer removal event while older read is delayed",
    );
    const oldReadCount = reads;
    await sleep(100);
    assert.equal(reads, oldReadCount, "Host-view reads remain serialized");
    await release(heldReads);
    await wait(async () => heldReads.length === 1, "queued authoritative removal read");
    assert.equal(await revision(heldReads[0]!), 4);
    holdReads = false;
    await release(heldReads);
    await wait(
      async () => !(await displayed(grouping)),
      "newer removal rendered before mutation response",
    );
    await browser.evaluate(`(() => {
      const state = globalThis.__hostViewProof;
      state.observer = new MutationObserver(() => {
        if (document.querySelector(${JSON.stringify(grouping)})) state.resurrected = true;
      });
      state.observer.observe(document.body, { childList: true, subtree: true });
    })()`);
    holdReads = true;
    holdAction = false;
    await release(heldActions);
    await wait(
      async () => heldReads.length === 1 && !(await displayed(editor)),
      "delayed action completed with authoritative refresh held",
    );
    assert.equal(await revision(heldReads[0]!), 4);
    assert.equal(
      await displayed(grouping),
      false,
      "Delayed revision three cannot resurrect removed grouping",
    );
    assert.equal(await browser.evaluate<boolean>("globalThis.__hostViewProof.resurrected"), false);
    await screenshot("delayed-action-no-resurrection");
    holdReads = false;
    await release(heldReads);
    const finalReads = reads;
    await sleep(2_200);
    assert.equal(reads, finalReads);
    assert.equal(await browser.evaluate<boolean>("globalThis.__hostViewProof.resurrected"), false);
    assert.equal(
      await browser.evaluate<boolean>(
        'globalThis.__hostViewProof.rail === document.querySelector("[data-testid=machines-rail]")',
      ),
      true,
    );
    assert.equal(failedInterception, false);
    assert.equal(
      browser.drainMessages().some((message) => message.kind === "exception"),
      false,
    );
    receipt.phase = "complete";
    receipt.passed = true;
  } catch {
    // The phase identifies the failed assertion without leaking raw fixture/process output.
    receipt.passed = false;
  } finally {
    if (interception) {
      try {
        await cdp("Fetch.disable", {});
      } catch {
        receipt.passed = false;
      }
    }
    for (const off of unsubscribe) off();
    try {
      await browser.close();
      receipt.cleanup.browser = true;
    } catch {
      receipt.passed = false;
    }
    if (agent !== undefined) {
      try {
        await agent.stop();
        receipt.cleanup.agent = true;
      } catch {
        receipt.passed = false;
      }
    }
    if (hub !== undefined) {
      try {
        await hub.stop();
        receipt.cleanup.server = true;
      } catch {
        receipt.passed = false;
      }
      if (receipt.cleanup.server) {
        try {
          rmSync(hub.dataDir, { recursive: true, force: true });
          receipt.cleanup.data = true;
        } catch {
          receipt.passed = false;
        }
      }
    }
  }
}

try {
  await prove(false);
  await prove(true);
} finally {
  dist.cleanup();
  await Bun.write(join(artifacts, "receipt.json"), JSON.stringify(receipts, null, 2));
}
console.log(JSON.stringify(receipts));
if (
  receipts.some(
    (receipt) => !receipt.passed || Object.values(receipt.cleanup).some((value) => !value),
  )
)
  process.exitCode = 1;
