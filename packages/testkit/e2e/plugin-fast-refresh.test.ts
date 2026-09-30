import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import { createContainer, ownerAction, startServer, waitFor, type TestServer } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(ROOT, "packages/plugin-kit/test/fixtures/fast-refresh");
const ID = "example.fast-refresh";
const PACKED_COLOR = "rgb(41, 83, 127)";
const SOURCE_COLOR = "rgb(37, 151, 79)";
const UPDATED_COLOR = "rgb(179, 73, 31)";
const REVISION_COLOR = "rgb(73, 61, 181)";

interface Packed {
  readonly file: string;
  readonly sha256: string;
}

interface RefreshProcess {
  readonly url: string;
  readonly output: readonly string[];
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

interface PanelState {
  readonly heading: string | null;
  readonly input: string | null;
  readonly draft: string | null;
  readonly count: string | null;
}

async function pack(root: string, file: string): Promise<Packed> {
  // Like the existing install fixture, use the author's CLI outside Bun.test's isolated linker.
  const proc = Bun.spawn(["bun", join(ROOT, "packages/plugin-kit/src/pack.ts"), root, "--out", file], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(`pack failed: ${stderr}`);
  return JSON.parse(stdout) as Packed;
}

async function startRefresh(root: string, server: TestServer): Promise<RefreshProcess> {
  // This is the public manifold-dev bin. Spawning it directly makes SIGKILL hit the Vite owner,
  // rather than an intermediate package-script process that could leave its child running.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (!key.startsWith("MANIFOLD_") ||
        ["MANIFOLD_VERSION", "MANIFOLD_BUILD", "MANIFOLD_CHANNEL"].includes(key))
    ) {
      env[key] = value;
    }
  }
  const proc = Bun.spawn(
    [
      "bun",
      join(ROOT, "packages/plugin-kit/src/dev.ts"),
      root,
      "--fast-refresh",
      "--hub",
      server.httpUrl,
      "--port",
      "0",
    ],
    { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const output: string[] = [];
  let readyUrl: string | null = null;
  let failure: unknown = null;
  const consume = async (stream: ReadableStream<Uint8Array>, stdout: boolean): Promise<void> => {
    let pending = "";
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        output.push(line);
        if (output.length > 100) output.shift();
        if (!stdout || !line.startsWith("{")) continue;
        const value: unknown = JSON.parse(line);
        if (
          typeof value === "object" &&
          value !== null &&
          "event" in value &&
          value.event === "plugin-refresh-ready" &&
          "url" in value &&
          typeof value.url === "string"
        ) {
          readyUrl = value.url;
        }
      }
    }
    if (pending !== "") output.push(pending);
  };
  const reads = Promise.all([consume(proc.stdout, true), consume(proc.stderr, false)]);
  void reads.catch((error: unknown) => { failure = error; });
  void proc.exited.then((code) => {
    if (readyUrl === null) failure = new Error(`refresh exited before readiness: ${code}`);
  });
  let stopped = false;
  const stop = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> => {
    if (stopped) return;
    stopped = true;
    proc.kill(signal);
    try {
      const { code } = await waitFor(
        () => proc.exitCode === null ? false : { code: proc.exitCode },
        10_000,
        25,
      );
      await reads;
      if (signal === "SIGTERM" && code !== 0) throw new Error(`refresh close failed: ${code}`);
    } catch (error) {
      proc.kill("SIGKILL");
      await proc.exited;
      throw error;
    }
  };
  try {
    const url = await waitFor(() => {
      if (failure !== null) throw failure;
      return readyUrl;
    }, 30_000, 25);
    return { url, output, stop };
  } catch (error) {
    await stop("SIGKILL");
    throw new Error(`plugin refresh failed: ${output.join("\n")}`, { cause: error });
  }
}

async function click(browser: Browser, selector: string): Promise<void> {
  const point = await browser.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (point === null) throw new Error(`no clickable element: ${selector}`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}

async function openPanels(
  browser: Browser,
  url: string,
  server: TestServer,
  containerId: string,
  marker: string,
): Promise<void> {
  const destination = new URL(url);
  destination.hash = `key=${server.ownerKey}`;
  await browser.goto(destination.href);
  await waitFor(
    () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
    15_000,
    50,
  );
  await browser.typeInto("#identity-name", marker);
  await browser.clickTestId("identity-enter");
  await waitFor(
    () => browser.evaluate<boolean>("document.querySelector('#identity-name') === null"),
    15_000,
    50,
  );
  expect(
    await browser.evaluate<boolean>(`(async () => {
      const identity = JSON.parse(localStorage.getItem("manifold.identity"));
      const headers = { Authorization: "Bearer " + identity.token, "Content-Type": "application/json" };
      const { layout } = await (await fetch("/api/layout", { headers })).json();
      const panels = [
        ["refresh-counter", "${ID}.counter"],
        ["refresh-separate", "${ID}.separate"],
        ["refresh-unrelated", "example.counter.counter"],
        ["refresh-missing", "example.not-installed.counter"],
      ];
      layout.root.children = panels.map(([id]) => id);
      layout.root.ratios = [1, 1, 1, 0.3];
      for (const [id, panelId] of panels) {
        layout[id] = { id, dir: null, ratios: [], children: [], ref: { kind: "panel", panelId } };
      }
      return (await (await fetch("/api/actions/core.space.setLayout", {
        method: "POST", headers, body: JSON.stringify({ layout }),
      })).json()).ok;
    })()`),
  ).toBe(true);
  destination.pathname = `/p/${containerId}`;
  destination.hash = "";
  await browser.goto(destination.href);
  await waitFor(
    () => browser.evaluate<boolean>("document.querySelector('[data-testid=refresh-counter]') !== null"),
    15_000,
    50,
  );
  await waitFor(
    () => browser.evaluate<boolean>("document.querySelector('[data-testid=in-realm-counter]') !== null"),
    15_000,
    50,
  );
  await browser.evaluate(`globalThis.__pluginRefreshDocument = ${JSON.stringify(marker)}`);
}

function state(browser: Browser, separate = false): Promise<PanelState> {
  const prefix = separate ? "refresh-separate" : "refresh";
  return browser.evaluate<PanelState>(`(() => {
    const read = (name) => document.querySelector('[data-testid=${prefix}-' + name + ']');
    return {
      heading: read("heading")?.textContent ?? null,
      input: read("input")?.value ?? null,
      draft: read("draft")?.textContent ?? null,
      count: read("count")?.textContent ?? null,
    };
  })()`);
}

async function heading(browser: Browser, expected: string, separate = false): Promise<void> {
  await waitFor(async () => (await state(browser, separate)).heading === expected, 15_000, 50);
}

async function expectStyles(
  browser: Browser,
  color: string,
  lease: string,
  packed: boolean,
): Promise<void> {
  await waitFor(
    () => browser.evaluate<boolean>(`(() => {
      const panel = document.querySelector("[data-testid=refresh-counter]");
      return panel !== null && getComputedStyle(panel).color === ${JSON.stringify(color)};
    })()`),
    10_000,
    50,
  );
  expect(
    await browser.evaluate(`(() => {
      const panel = document.querySelector("[data-testid=refresh-counter]");
      const sheets = [...document.querySelectorAll("style")];
      return {
        lease: getComputedStyle(panel).getPropertyValue("--fast-refresh-lease").trim(),
        packed: document.querySelectorAll('style[data-plugin="${ID}"]').length,
        owned: sheets.filter((sheet) => sheet.textContent.includes(".plugin-example_fast-refresh")).length,
        ineligible: sheets.some((sheet) => sheet.textContent.includes("--fast-refresh-ineligible")),
      };
    })()`),
  ).toEqual({ lease, packed: packed ? 1 : 0, owned: 1, ineligible: false });
}

async function interact(browser: Browser): Promise<void> {
  await browser.typeInto("[data-testid=refresh-input]", "draft survives");
  await browser.typeInto("[data-testid=refresh-separate-input]", "separate survives");
  for (let i = 0; i < 2; i++) await click(browser, "[data-testid=refresh-increment]");
  for (let i = 0; i < 3; i++) await click(browser, "[data-testid=refresh-separate-increment]");
  for (let i = 0; i < 4; i++) await click(browser, ".plugin-example_counter button");
  await waitFor(async () => (await state(browser)).count === "2", 5_000, 25);
  await waitFor(async () => (await state(browser, true)).count === "3", 5_000, 25);
  await waitFor(
    () => browser.evaluate<boolean>("document.querySelector('[data-testid=in-realm-counter]').textContent === '4'"),
    5_000,
    25,
  );
}

async function expectUnrelated(browser: Browser, marker: string, count = "4"): Promise<void> {
  expect(
    await browser.evaluate(`(() => {
      const other = document.querySelector("[data-testid=in-realm-counter]");
      return {
        marker: globalThis.__pluginRefreshDocument,
        count: other?.textContent ?? null,
        color: other === null ? null : getComputedStyle(other).color,
        missing: document.querySelector("[data-testid=refresh-not-installed]") !== null,
        mismatched: document.querySelector("[data-testid=refresh-manifest-mismatch]") !== null,
      };
    })()`),
  ).toEqual({ marker, count, color: "rgb(214, 63, 98)", missing: false, mismatched: false });
}

function expectedState(title: string, separate = false): PanelState {
  return {
    heading: title,
    input: separate ? "separate survives" : "draft survives",
    draft: separate ? "separate survives" : "draft survives",
    count: separate ? "3" : "2",
  };
}

async function expectRefreshState(browser: Browser, entry: string, separate: string): Promise<void> {
  expect(await state(browser)).toEqual(expectedState(entry));
  expect(await state(browser, true)).toEqual(expectedState(separate, true));
}

async function editAfterCancellation(browser: Browser, file: string, contents: string): Promise<void> {
  // Wait for Vite's completed public HMR event, not a delay that could let a late readmission pass.
  let updated = false;
  const off = browser.on("Runtime.consoleAPICalled", (params) => {
    const args = params["args"];
    if (!Array.isArray(args)) return;
    updated ||= args.some((arg: unknown) =>
      typeof arg === "object" && arg !== null && "value" in arg &&
      typeof arg.value === "string" && arg.value.includes("[vite] hot updated:"),
    );
  });
  try {
    writeFileSync(file, contents);
    await waitFor(() => updated, 10_000, 25);
    await browser.evaluate(`(() => {
      const completion = Promise.withResolvers();
      requestAnimationFrame(() => requestAnimationFrame(completion.resolve));
      return completion.promise;
    })()`);
  } finally {
    off();
  }
}

// One disposable hub admits the packed artifact before the separate development frontend exists.
// Its ordinary browser remains open throughout: source changes are never installation changes.
test("public Fast Refresh preserves React state and leases CSS; cancellation restores the admitted packed plugin", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-plugin-refresh-"));
  const sourceRoot = join(scratch, "plugins");
  cpSync(FIXTURE, sourceRoot, { recursive: true });
  const eligible = join(sourceRoot, "eligible");
  const webFile = join(eligible, "web.tsx");
  const separateFile = join(eligible, "Separate.tsx");
  const cssFile = join(eligible, "styles.css");
  const originalWeb = await Bun.file(webFile).text();
  const originalSeparate = await Bun.file(separateFile).text();
  let cleanupDist: (() => void) | undefined;
  let server: TestServer | null = null;
  const packedBrowser = new Browser();
  const development = new Browser();
  const refreshes: RefreshProcess[] = [];
  let active: RefreshProcess | null = null;
  try {
    const dist = resolveWebDist("manifold-plugin-refresh-web-");
    cleanupDist = dist.cleanup;
    server = await startServer({
      ownerKey: randomBytes(32).toString("hex"),
      env: { MANIFOLD_PLUGIN_DEV_PATHS: "1", MANIFOLD_WEB_DIST: dist.distDir },
    });
    const baseline = await pack(eligible, join(scratch, "baseline.json"));
    const unrelated = await pack(
      join(ROOT, "packages/plugin-kit/test/fixtures/in-realm"),
      join(scratch, "unrelated.json"),
    );
    for (const bundle of [baseline, unrelated]) {
      await ownerAction(server, "engine.plugins.install", {
        source: bundle.file,
        sha256: bundle.sha256,
        hardened: false,
      });
    }
    const container = await createContainer(server, "Source refresh acceptance");
    await packedBrowser.launch();
    await development.launch();
    await openPanels(packedBrowser, server.httpUrl, server, container.id, "packed-baseline");
    await heading(packedBrowser, "Packed entry");
    await heading(packedBrowser, "Packed separate", true);
    await expectStyles(packedBrowser, PACKED_COLOR, "packed", true);
    await interact(packedBrowser);

    let sourceWeb = originalWeb.replace("Packed entry", "Source entry");
    let sourceSeparate = originalSeparate.replace("Packed separate", "Source separate");
    writeFileSync(webFile, sourceWeb);
    writeFileSync(separateFile, sourceSeparate);
    writeFileSync(cssFile, `.plugin-example_fast-refresh { color: ${SOURCE_COLOR}; --fast-refresh-lease: source; }\n`);
    // The development HTTP surface must not widen the registered explicit source tree.
    const denied = "private-fixture-not-a-credential";
    writeFileSync(join(eligible, ".env"), denied);
    writeFileSync(join(eligible, "owner.key"), denied);
    mkdirSync(join(eligible, ".git"));
    writeFileSync(join(eligible, ".git/config"), denied);
    const outside = join(scratch, "outside.ts");
    writeFileSync(outside, `export const privateFixture = ${JSON.stringify(denied)};`);
    symlinkSync(outside, join(eligible, "escaped.ts"));
    active = await startRefresh(sourceRoot, server);
    refreshes.push(active);
    await openPanels(development, active.url, server, container.id, "source-edits");
    await heading(development, "Source entry");
    await heading(development, "Source separate", true);
    await expectStyles(development, SOURCE_COLOR, "source", false);
    await expectUnrelated(development, "source-edits", "0");
    await interact(development);

    for (const file of [
      join(eligible, ".env"),
      join(eligible, "owner.key"),
      join(eligible, ".git/config"),
      join(eligible, "escaped.ts"),
      outside,
    ]) {
      const response = await fetch(new URL(`/@fs${file}`, active.url));
      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(denied);
    }

    writeFileSync(cssFile, `.plugin-example_fast-refresh { color: ${UPDATED_COLOR}; --fast-refresh-lease: source-updated; }\n`);
    await expectStyles(development, UPDATED_COLOR, "source-updated", false);
    await expectRefreshState(development, "Source entry", "Source separate");
    await expectUnrelated(development, "source-edits");

    // Forbidden source ink is a recoverable edit error, never a rule that reaches another panel.
    writeFileSync(cssFile, ".plugin-example_counter { color: rgb(199, 11, 99); }\n");
    await waitFor(
      () => development.evaluate<boolean>("document.querySelector('vite-error-overlay') !== null"),
      10_000,
      50,
    );
    await expectStyles(development, UPDATED_COLOR, "source-updated", false);
    await expectRefreshState(development, "Source entry", "Source separate");
    await expectUnrelated(development, "source-edits");
    writeFileSync(cssFile, `.plugin-example_fast-refresh { color: ${UPDATED_COLOR}; --fast-refresh-lease: source-updated; }\n`);
    await waitFor(
      () => development.evaluate<boolean>("document.querySelector('vite-error-overlay') === null"),
      10_000,
      50,
    );
    await expectStyles(development, UPDATED_COLOR, "source-updated", false);
    await expectRefreshState(development, "Source entry", "Source separate");

    sourceWeb = sourceWeb.replace("Source entry", "Edited entry");
    writeFileSync(webFile, sourceWeb);
    await heading(development, "Edited entry");
    await expectRefreshState(development, "Edited entry", "Source separate");
    await expectUnrelated(development, "source-edits");
    sourceSeparate = sourceSeparate.replace("Source separate", "Edited separate");
    writeFileSync(separateFile, sourceSeparate);
    await heading(development, "Edited separate", true);
    await expectRefreshState(development, "Edited entry", "Edited separate");
    await expectUnrelated(development, "source-edits");

    writeFileSync(webFile, "export default { id: ");
    await waitFor(
      () => development.evaluate<boolean>("document.querySelector('vite-error-overlay') !== null"),
      10_000,
      50,
    );
    await expectRefreshState(development, "Edited entry", "Edited separate");
    await expectUnrelated(development, "source-edits");
    sourceWeb = sourceWeb.replace("Edited entry", "Recovered entry");
    writeFileSync(webFile, sourceWeb);
    await heading(development, "Recovered entry");
    await waitFor(
      () => development.evaluate<boolean>("document.querySelector('vite-error-overlay') === null"),
      10_000,
      50,
    );
    await expectRefreshState(development, "Recovered entry", "Edited separate");
    await expectStyles(development, UPDATED_COLOR, "source-updated", false);
    await expectUnrelated(development, "source-edits");
    const screenshotPath = process.env["MANIFOLD_PLUGIN_REFRESH_SCREENSHOT"];
    if (screenshotPath !== undefined && screenshotPath !== "") {
      const frame = await development.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const data = frame.result?.["data"];
      if (typeof data !== "string") throw new Error("Chromium returned no refresh screenshot");
      await Bun.write(screenshotPath, Buffer.from(data, "base64"));
    }

    // A new descriptor component is an honest incompatible boundary, not a component edit.
    sourceWeb = sourceWeb
      .replace("export default {", "function ReplacementCounter() { return <Counter />; }\n\nexport default {")
      .replace("counter: Counter,", "counter: ReplacementCounter,");
    writeFileSync(webFile, sourceWeb);
    await waitFor(async () => (await state(development)).count === "0", 10_000, 50);
    expect(await state(development)).toEqual({ heading: "Recovered entry", input: "", draft: "", count: "0" });
    expect(await state(development, true)).toEqual(expectedState("Edited separate", true));
    await expectUnrelated(development, "source-edits");

    await active.stop();
    await heading(development, "Packed entry");
    await heading(development, "Packed separate", true);
    await expectStyles(development, PACKED_COLOR, "packed", true);
    expect(await state(development)).toEqual({ heading: "Packed entry", input: "", draft: "", count: "0" });
    await expectUnrelated(development, "source-edits");
    await expectRefreshState(packedBrowser, "Packed entry", "Packed separate");
    await expectStyles(packedBrowser, PACKED_COLOR, "packed", true);
    await expectUnrelated(packedBrowser, "packed-baseline");

    // Disable cancels this source lease permanently; re-enable restores the packed artifact.
    active = await startRefresh(sourceRoot, server);
    refreshes.push(active);
    await openPanels(development, active.url, server, container.id, "source-disable");
    await heading(development, "Recovered entry");
    await interact(development);
    await ownerAction(server, "engine.plugins.setEnabled", { id: ID, enabled: false });
    await waitFor(
      () => development.evaluate<boolean>("document.querySelector('[data-testid=refresh-counter]') === null"),
      10_000,
      50,
    );
    expect(
      await development.evaluate<number>("[...document.querySelectorAll('style')].filter((sheet) => sheet.textContent.includes('.plugin-example_fast-refresh')).length"),
    ).toBe(0);
    await expectUnrelated(development, "source-disable");
    await ownerAction(server, "engine.plugins.setEnabled", { id: ID, enabled: true });
    await heading(development, "Packed entry");
    await expectStyles(development, PACKED_COLOR, "packed", true);
    sourceWeb = sourceWeb.replace("Recovered entry", "Source after disable");
    await editAfterCancellation(development, webFile, sourceWeb);
    expect((await state(development)).heading).toBe("Packed entry");
    await expectStyles(development, PACKED_COLOR, "packed", true);
    await expectUnrelated(development, "source-disable");
    await active.stop();

    // An authoritative installed pin change cannot silently readmit the already loaded source.
    active = await startRefresh(sourceRoot, server);
    refreshes.push(active);
    await openPanels(development, active.url, server, container.id, "source-pin");
    await heading(development, "Source after disable");
    await interact(development);
    const revisionRoot = join(scratch, "revision");
    cpSync(join(FIXTURE, "eligible"), revisionRoot, { recursive: true });
    writeFileSync(join(revisionRoot, "web.tsx"), originalWeb.replace("Packed entry", "Installed revision two"));
    writeFileSync(join(revisionRoot, "Separate.tsx"), originalSeparate.replace("Packed separate", "Installed separate two"));
    writeFileSync(join(revisionRoot, "styles.css"), `.plugin-example_fast-refresh { color: ${REVISION_COLOR}; --fast-refresh-lease: installed-two; }\n`);
    const revision = await pack(revisionRoot, join(scratch, "revision.json"));
    expect(revision.sha256).not.toBe(baseline.sha256);
    await ownerAction(server, "engine.plugins.install", { source: revision.file, sha256: revision.sha256, hardened: false });
    await heading(development, "Installed revision two");
    await expectStyles(development, REVISION_COLOR, "installed-two", true);
    sourceWeb = sourceWeb.replace("Source after disable", "Source after pin");
    await editAfterCancellation(development, webFile, sourceWeb);
    expect((await state(development)).heading).toBe("Installed revision two");
    await expectStyles(development, REVISION_COLOR, "installed-two", true);
    await expectUnrelated(development, "source-pin");
    await active.stop();

    // No orderly shutdown notification, and no remaining source HTTP server: the retained real
    // installed definition and CSS must still win, without reloading this document or its peer.
    active = await startRefresh(sourceRoot, server);
    refreshes.push(active);
    await openPanels(development, active.url, server, container.id, "source-crash");
    await heading(development, "Source after pin");
    await expectStyles(development, UPDATED_COLOR, "source-updated", false);
    await interact(development);
    await active.stop("SIGKILL");
    await heading(development, "Installed revision two");
    await heading(development, "Installed separate two", true);
    await expectStyles(development, REVISION_COLOR, "installed-two", true);
    expect(await state(development)).toEqual({ heading: "Installed revision two", input: "", draft: "", count: "0" });
    await expectUnrelated(development, "source-crash");
  } catch (error) {
    let diagnostics = JSON.stringify({
      body: await development.evaluate("document.body.innerText").catch(() => "browser unavailable"),
      messages: development.drainMessages(),
      refresh: active?.output,
    });
    if (server !== null) diagnostics = diagnostics.replaceAll(server.ownerKey, "[fixture-key]");
    console.error(diagnostics);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...refreshes.map((refresh) => refresh.stop()),
      development.close(),
      packedBrowser.close(),
      ...(server === null ? [] : [server.stop()]),
    ]);
    if (server !== null) rmSync(server.dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    cleanupDist?.();
    for (const result of cleanup) {
      if (result.status === "rejected") throw result.reason;
    }
  }
}, 240_000);
