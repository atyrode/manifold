/**
 * Real TerminalView diagnostic, not a gate and not physical-paint instrumentation.
 * Usage: bun scripts/bench-terminal-ui.ts [--help]
 * MANIFOLD_CHROMIUM selects Chromium; MANIFOLD_GATE_DIST reuses an existing web build.
 * Otherwise resolveWebDist builds an isolated bundle. BENCH_TERMINAL_KEEP=1 retains PNGs
 * in the printed artifact directory, except drag-held labels: those remain DOM-only so
 * screenshots cannot insert debounce-length pauses. Capture costs and phase bounds are
 * reported. BENCH_TERMINAL_REPORT selects an atomically replaced raw JSON file (default:
 * a separate temporary .json file). Stdout is a bounded summary, not the raw report.
 * Server data and verified browser profiles are still removed.
 * No remote-origin option: this script only operates its own localhost server and PTYs.
 */
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir, platform, release, arch } from "node:os";
import { join } from "node:path";
import { Browser } from "./cdp.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { ownerKeyOf, reserveLoopbackPort, sleep, teardownServer, until } from "./gate-lib.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  MachinesResponseSchema,
  PlaceResponseSchema,
  PrincipalSchema,
  TokenGrantSchema,
  ROOT_TILE_ID,
} from "../packages/protocol/src/index.ts";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: bun scripts/bench-terminal-ui.ts\nIsolated localhost server+agent+two Chromium instances, one shared human grant verified against SDK and browser session init. Requires Bun, Chromium and installed workspace dependencies. MANIFOLD_GATE_DIST reuses a build; otherwise builds a temporary bundle. BENCH_TERMINAL_KEEP=1 retains screenshots except drag-held labels (always DOM-only to preserve continuous drag cadence). Observer costs and phase boundaries are reported. Finite font 13→32→8→13, 24-step held divider drag, competing viewports, 5 Enter-to-DOM samples. BENCH_TERMINAL_REPORT selects an atomically replaced raw JSON file (default: separate temporary .json file); stdout is a bounded summary. Nonzero only for execution errors, not observed geometry defects. No physical paint, native OS, GPU or WAN claim.",
  );
  process.exit(0);
}

interface WireSample {
  browser: string;
  phase: string;
  direction: string;
  cdpSeconds: number;
  observedMs: number;
  type: string;
  terminalId?: string;
  cols?: number;
  rows?: number;
  kind?: string;
}
interface PageTiming {
  frames: number[];
  longTasks: { startMs: number; durationMs: number }[];
  keys: { startMs: number; visibleMs: number | null; marker: string }[];
  resizeObservations: unknown[];
  pointerEvents: unknown[];
  dropped: number;
}
interface Capture {
  label: string;
  browser: string;
  observation: unknown;
  screenshot?: string;
  observerCost: {
    phase: string;
    startedMs: number;
    domCompleteMs: number;
    completedMs: number;
    domMs: number;
    screenshotMs: number;
    screenshotPolicy: string;
  };
}
const repoRoot = join(import.meta.dir, "..");
const keep = process.env["BENCH_TERMINAL_KEEP"] === "1";
const wires: WireSample[] = [];
const captures: Capture[] = [];
const sessionIdentities: {
  browser: string;
  type: string;
  principalId: string;
  containerId: string | null;
  matchesGrant: boolean;
}[] = [];
const gestureTimeline: { label: string; observedMs: number }[] = [];
let expectedPrincipalId = "";
let grantToken = "";
const errors: string[] = [];
const observations: Record<string, unknown> = {};
const clickDiagnostics: unknown[] = [];
let clickSerial = 0;
observations["clickDiagnostics"] = clickDiagnostics;
const browsers: { name: string; browser: Browser; profile?: string; proc?: Bun.Subprocess }[] = [];
let client: SessionClient | null = null;
let server: Bun.Subprocess | null = null;
let cleanupDist: (() => void) | null = null;
let dataDir = "";
let artifacts = "";
let secret = "";
let phase = "bootstrap";
const phaseTimeline = [{ phase, observedMs: performance.now() }];
function enterPhase(next: string): void {
  phase = next;
  phaseTimeline.push({ phase, observedMs: performance.now() });
}
const sanitize = (value: string): string =>
  [secret, grantToken].reduce(
    (text, credential) => (credential === "" ? text : text.replaceAll(credential, "[redacted]")),
    value,
  );
const stats = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    unit: "ms",
    count: sorted.length,
    p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? null,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
    max: sorted.at(-1) ?? null,
  };
};
// Browser.evaluate does not surface Runtime exceptionDetails; diagnostics must not silently
// turn exceptions into undefined measurements. Keep error checking local to this script.
async function evaluate<T>(browser: Browser, expression: string): Promise<T> {
  const reply = await browser.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const protocolError = Reflect.get(reply, "error") as { message?: string } | undefined;
  const exception = reply.result?.["exceptionDetails"] as
    { text?: string; exception?: { description?: string } } | undefined;
  if (protocolError !== undefined || exception !== undefined) {
    const detail =
      protocolError?.message ??
      exception?.exception?.description ??
      exception?.text ??
      "unknown CDP error";
    throw new Error(`page evaluation failed in ${phase}: ${sanitize(detail).slice(0, 600)}`);
  }
  const remote = reply.result?.["result"] as { value?: T } | undefined;
  if (remote === undefined || !("value" in remote))
    throw new Error(`page evaluation returned no value in ${phase}`);
  return remote.value as T;
}
async function cdp(
  browser: Browser,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await browser.send(method, params);
  if (Reflect.get(reply, "error") !== undefined)
    throw new Error(
      `CDP ${method} failed: ${sanitize(JSON.stringify(Reflect.get(reply, "error"))).slice(0, 600)}`,
    );
  return reply.result ?? {};
}
const instrumentation = `(() => {
  const lab = { frames: [], longTasks: [], keys: [], resizeObservations: [], pointerEvents: [], dropped: 0, armed: null, last: null };
  window.__terminalLab = lab;
  const push = (list, item) => { if (list.length < 20000) list.push(item); else lab.dropped++; };
  const hosts = new WeakSet();
  const resize = new ResizeObserver(entries => { for (const e of entries) push(lab.resizeObservations, {timeMs:performance.now(),hostIndex:[...document.querySelectorAll('.xterm-host')].indexOf(e.target),width:e.contentRect.width,height:e.contentRect.height}); });
  const observeHosts = () => { for (const host of document.querySelectorAll('.xterm-host')) if (!hosts.has(host)) { hosts.add(host); resize.observe(host); } };
  new MutationObserver(observeHosts).observe(document,{childList:true,subtree:true});
  for (const type of ['pointerdown','pointermove','pointerup']) document.addEventListener(type, e => {
    if (type === 'pointermove' && !e.buttons) return;
    push(lab.pointerEvents,{type,timeMs:performance.now(),x:e.clientX,y:e.clientY,buttons:e.buttons,separator:!!e.target.closest?.('[role="separator"]')});
  },true);
  const frame = t => { if (lab.last !== null) push(lab.frames, t - lab.last); lab.last = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) push(lab.longTasks, {startMs:entry.startTime,durationMs:entry.duration});
  }).observe({type:'longtask',buffered:true});
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || lab.armed === null) return;
    push(lab.keys, {startMs:performance.now(),visibleMs:null,marker:lab.armed}); lab.armed = null;
  }, true);
  new MutationObserver(() => {
    for (const sample of lab.keys) {
      if (sample.visibleMs !== null) continue;
      if ([...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.trim() === sample.marker)) sample.visibleMs = performance.now();
    }
  }).observe(document,{childList:true,subtree:true,characterData:true});
  return true;
})();`;

async function browserProfile(browser: Browser): Promise<string> {
  // Navigate only our managed CDP page, after collecting its timing. The retained
  // launcher PID may be a Nix wrapper, not the process holding --user-data-dir.
  const navigation = await cdp(browser, "Page.navigate", { url: "chrome://version/" });
  if (typeof navigation["errorText"] === "string")
    throw new Error(`chrome://version navigation failed: ${navigation["errorText"]}`);
  // Match Browser.goto's navigation settling delay, outside all measurement phases.
  await sleep(1500);
  let profilePath: string | null = null;
  await until(
    async () => {
      profilePath = await evaluate<string | null>(
        browser,
        "location.protocol === 'chrome:' && location.hostname === 'version' ? document.querySelector('#profile_path')?.textContent?.trim() ?? null : null",
      );
      return profilePath !== null && profilePath !== "";
    },
    5000,
    "own Chromium chrome://version profile path",
  );
  const match = /^(\/tmp\/manifold-verify-[0-9]+-[0-9]+)(?:\/Default)?$/.exec(String(profilePath));
  const profile = match?.[1];
  if (profile === undefined)
    throw new Error(`own Chromium reported an unexpected profile path: ${String(profilePath)}`);
  return profile;
}

async function waitForBrowserExit(proc: Bun.Subprocess): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function launch(name: string, width: number, height: number, dpr: number): Promise<Browser> {
  const browser = new Browser();
  const record: (typeof browsers)[number] = { name, browser };
  browsers.push(record);
  try {
    await browser.launch();
  } finally {
    // Keep only our launcher's handle; identify the actual profile via CDP at cleanup.
    const proc = Reflect.get(browser, "proc") as Bun.Subprocess | null;
    if (proc !== null && proc !== undefined) record.proc = proc;
  }
  await cdp(browser, "Network.enable", {});
  for (const [event, direction] of [
    ["Network.webSocketFrameSent", "out"],
    ["Network.webSocketFrameReceived", "in"],
  ] as const)
    browser.on(event, (params) => {
      const response = params["response"] as { payloadData?: string; opcode?: number } | undefined;
      if (response?.opcode !== 1 || response.payloadData === undefined) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(response.payloadData) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message === null || typeof message !== "object") return;
      if (direction === "in" && (message["type"] === "init" || message["type"] === "resync")) {
        const self = PrincipalSchema.safeParse(message["self"]);
        if (sessionIdentities.length < 1000)
          sessionIdentities.push({
            browser: name,
            type: String(message["type"]),
            principalId: self.success ? self.data.id : "invalid",
            containerId: typeof message["containerId"] === "string" ? message["containerId"] : null,
            matchesGrant: self.success && self.data.id === expectedPrincipalId,
          });
        else observations["sessionIdentityOverflow"] = true;
        if (!self.success || self.data.id !== expectedPrincipalId) {
          if (errors.length < 100)
            errors.push(
              `${name}: session ${String(message["type"])} principal differs from lab grant`,
            );
        }
      }
      if (
        message["type"] !== "terminal_resize" &&
        !(message["type"] === "terminal_event" && message["kind"] === "resized")
      )
        return;
      if (wires.length >= 20000) {
        observations["wireCaptureOverflow"] = true;
        return;
      }
      wires.push({
        browser: name,
        phase,
        direction,
        cdpSeconds: Number(params["timestamp"]),
        observedMs: performance.now(),
        type: String(message["type"]),
        ...(typeof message["terminalId"] === "string" ? { terminalId: message["terminalId"] } : {}),
        ...(typeof message["cols"] === "number" ? { cols: message["cols"] } : {}),
        ...(typeof message["rows"] === "number" ? { rows: message["rows"] } : {}),
        ...(typeof message["kind"] === "string" ? { kind: message["kind"] } : {}),
      });
    });
  await cdp(browser, "Page.addScriptToEvaluateOnNewDocument", { source: instrumentation });
  // New-document scripts do not run retroactively on the helper's initial about:blank.
  // This also proves the probe returns a serializable value before navigation.
  await evaluate<boolean>(browser, instrumentation);
  await cdp(browser, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  return browser;
}
async function click(browser: Browser, selector: string, expectedFont?: number): Promise<void> {
  const serial = ++clickSerial;
  let failure: unknown;
  let failed = false;
  try {
    const point = await evaluate<{ x: number; y: number } | null>(
      browser,
      `(() => {
      const selector=${JSON.stringify(selector)}, intended=document.querySelector(selector);
      const describe=e=>e instanceof Element ? {tag:e.tagName,id:e.id,classes:e.getAttribute('class'),label:e.getAttribute('aria-label'),disabled:e.matches(':disabled')} : null;
      const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
      const rect=box(intended), point=rect && {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      const fonts=()=>Array.from(document.querySelectorAll('.terminal-font-size'),e=>e.textContent);
      const hit=()=>point ? document.elementFromPoint(point.x,point.y) : null;
      const snapshot=()=>({timeMs:performance.now(),intended:describe(intended),rect:box(intended),connected:intended?.isConnected ?? false,receivingTarget:describe(hit()),hitIntended:!!intended && (hit()===intended || intended.contains(hit())),fonts:fonts(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY,visual:visualViewport && {width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop}},activeElement:describe(document.activeElement)});
      const data={serial:${serial},selector,expectedFont:${expectedFont ?? "null"},point,before:snapshot(),receivedIntendedClick:false,events:[],fontTransitions:[],pageErrors:[],dropped:0};
      const push=(list,item)=>{if(list.length<32)list.push(item);else data.dropped++;};
      let lastFonts=JSON.stringify(fonts());
      const recordFonts=()=>{const next=JSON.stringify(fonts());if(next!==lastFonts){push(data.fontTransitions,{timeMs:performance.now(),fonts:fonts()});lastFonts=next;}};
      const event=e=>{if(e.type==='click' && e.isTrusted && e.composedPath().includes(intended))data.receivedIntendedClick=true;push(data.events,{type:e.type,timeMs:performance.now(),x:e.clientX,y:e.clientY,buttons:e.buttons,button:e.button,isTrusted:e.isTrusted,defaultPrevented:e.defaultPrevented,target:describe(e.target),path:e.composedPath().slice(0,6).map(describe),hit:describe(document.elementFromPoint(e.clientX,e.clientY))});};
      const types=['pointermove','pointerdown','mousedown','pointerup','mouseup','click','pointercancel','gotpointercapture','lostpointercapture'];
      for(const type of types)window.addEventListener(type,event,true);
      const pageError=e=>push(data.pageErrors,{type:e.type,message:String(e.message ?? e.reason).slice(0,600)});
      window.addEventListener('error',pageError,true);window.addEventListener('unhandledrejection',pageError,true);
      const observer=new MutationObserver(recordFonts);observer.observe(document,{childList:true,subtree:true,characterData:true});
      window.__terminalLabClick={finish:()=>{recordFonts();observer.disconnect();for(const type of types)window.removeEventListener(type,event,true);window.removeEventListener('error',pageError,true);window.removeEventListener('unhandledrejection',pageError,true);return {...data,after:snapshot()};}};
      return intended && !intended.matches(':disabled') && rect.width>0 && rect.height>0 ? point : null;
    })()`,
    );
    if (point === null) throw new Error(`missing, disabled or empty control ${selector}`);
    // Keep real pointer delivery, but unlike Browser.drag check every CDP error reply.
    await cdp(browser, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
    await cdp(browser, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp(browser, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    if (expectedFont !== undefined) {
      await until(
        () =>
          evaluate<boolean>(
            browser,
            `Number(document.querySelector('.terminal-font-size')?.textContent) === ${expectedFont}`,
          ),
        3000,
        `font control committed ${expectedFont}`,
      );
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      const diagnostic = await evaluate<Record<string, unknown> | null>(
        browser,
        "(() => {const probe=window.__terminalLabClick;delete window.__terminalLabClick;return probe ? probe.finish() : null;})()",
      );
      if (!failed && diagnostic?.["receivedIntendedClick"] !== true) {
        failed = true;
        failure = new Error("no trusted click arrived through the intended element");
      }
      // Successful clicks need the observed outcome; retain full event paths only on failure.
      if (!failed && diagnostic !== null) delete diagnostic["events"];
      if (failed && clickDiagnostics.length >= 200) clickDiagnostics.pop();
      if (clickDiagnostics.length < 200)
        clickDiagnostics.push({
          serial,
          browser: browsers.find((b) => b.browser === browser)?.name,
          phase,
          failed,
          error: failed ? sanitize(String(failure)) : null,
          diagnostic,
        });
      else observations["clickDiagnosticOverflow"] = true;
    } catch (error) {
      errors.push(`click #${serial} diagnostic collection: ${sanitize(String(error))}`);
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    observations["clickCount"] = clickSerial;
  }
  if (failed)
    throw new Error(
      `real pointer click #${serial} failed (${selector}): ${sanitize(String(failure))}; see observations.clickDiagnostics for hit target, event arrivals, font transitions and viewport`,
    );
}
async function capture(browser: Browser, name: string, label: string): Promise<void> {
  const startedMs = performance.now();
  const observation = await evaluate<unknown>(
    browser,
    `(() => {
    const box = e => {if (!e) return null; const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,right:b.right};};
    return {timeMs:performance.now(), timeOriginMs:performance.timeOrigin, viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, terminals:[...document.querySelectorAll('.terminal-frame')].map(frame => {
      const host=frame.querySelector('.xterm-host'), screen=frame.querySelector('.xterm-screen'), rows=frame.querySelector('.xterm-rows');
      const h=box(host), s=box(screen), style=host && getComputedStyle(host);
      const rowText=rows ? [...rows.children].map(row => row.textContent) : [];
      const gridLines=rowText.filter(line => /^G\\d{2} [0-9]+x[0-9]+/.test(line));
      return {frame:box(frame),host:h,screen:s,titlebar:box(frame.querySelector('.terminal-titlebar')),font:frame.querySelector('.terminal-font-size')?.textContent,rowCount:rows?.children.length ?? 0,rowHeight:box(rows?.firstElementChild)?.height ?? null,hostClient:host && {width:host.clientWidth,height:host.clientHeight},padding:style && {top:style.paddingTop,bottom:style.paddingBottom,left:style.paddingLeft,right:style.paddingRight},overflow:style?.overflow,screenOverHostBottomPx:h && s ? Math.max(0,s.bottom-(h.bottom-parseFloat(style.paddingBottom))):null,screenOverHostRightPx:h && s ? Math.max(0,s.right-(h.right-parseFloat(style.paddingRight))):null,rowText,gridLines,gridDuplicateLabels:gridLines.map(s=>s.slice(0,3)).filter((s,i,a)=>a.indexOf(s)!==i),bottomMarker:rowText.some(s=>s.startsWith('BOTTOM ')),redrawLines:rowText.filter(s=>s.startsWith('REDRAW '))};
    })};
  })()`,
  );
  const domCompleteMs = performance.now();
  const screenshotAllowed = keep && !label.startsWith("drag-held-");
  const result: Capture = {
    browser: name,
    label,
    observation,
    observerCost: {
      phase,
      startedMs,
      domCompleteMs,
      completedMs: domCompleteMs,
      domMs: domCompleteMs - startedMs,
      screenshotMs: 0,
      screenshotPolicy: label.startsWith("drag-held-")
        ? "held-drag DOM-only"
        : keep
          ? "retained image"
          : "images disabled",
    },
  };
  if (screenshotAllowed) {
    const shot = await cdp(browser, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    if (typeof shot["data"] !== "string") throw new Error("screenshot returned no data");
    result.screenshot = join(
      artifacts,
      `${String(captures.length).padStart(3, "0")}-${name}-${label}.png`,
    );
    await Bun.write(result.screenshot, Buffer.from(shot["data"], "base64"));
  }
  result.observerCost.completedMs = performance.now();
  result.observerCost.screenshotMs = screenshotAllowed
    ? result.observerCost.completedMs - domCompleteMs
    : 0;
  captures.push(result);
}
async function font(browser: Browser, target: number): Promise<void> {
  for (let attempts = 0; attempts < 40; attempts++) {
    const size = await evaluate<number>(
      browser,
      "Number(document.querySelector('.terminal-font-size')?.textContent)",
    );
    if (size === target) return;
    if (!Number.isFinite(size)) throw new Error("font size missing");
    await click(
      browser,
      `[aria-label="${size < target ? "Increase" : "Decrease"} terminal font size"]`,
      size + (size < target ? 1 : -1),
    );
  }
  throw new Error("font control did not reach target");
}
// shell input uses real CDP keys; output-only markers are assembled from separate printf
// arguments so echoed command text cannot satisfy the DOM marker observation.
async function command(browser: Browser, text: string): Promise<void> {
  await click(browser, ".xterm-host");
  await browser.typeText(text);
  await cdp(browser, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await cdp(browser, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}
// Deterministic grid sampled from stty each iteration, no terminal query escape traffic.
// Explicit CUP+EL and no newline at bottom-right make wrap/duplicate redraws inspectable.
// Marker words are split across printf arguments so wrapped shell input cannot
// masquerade as BOTTOM/REDRAW output; the raw row text still retains echoed input.
const workload =
  'sh -c \'n=0; while [ $n -lt 150 ]; do set -- $(stty size); r=$1; c=$2; printf "\\033[2J\\033[H"; i=1; while [ $i -lt $r ]; do printf "\\033[%s;1H%s%02d %sx%s\\033[K" "$i" G "$i" "$c" "$r"; i=$((i+1)); done; printf "\\033[%s;1H%s%s %sx%s\\033[K\\033[2;1H%s%s %03d\\033[K" "$r" BOT TOM "$c" "$r" RE DRAW "$n"; n=$((n+1)); sleep 0.1; done\'';

try {
  const dist = resolveWebDist("manifold-ui-lab-dist-");
  cleanupDist = dist.cleanup;
  dataDir = mkdtempSync(join(tmpdir(), "manifold-ui-lab-data-"));
  artifacts = mkdtempSync(join(tmpdir(), "manifold-ui-lab-artifacts-"));
  const port = reserveLoopbackPort();
  const origin = `http://127.0.0.1:${String(port)}`;
  server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MANIFOLD_PORT: String(port),
      MANIFOLD_DATA_DIR: dataDir,
      MANIFOLD_WEB_DIST: dist.distDir,
      MANIFOLD_SPAWN_AGENT: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await until(
    async () => {
      try {
        return (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    20000,
    "isolated server health",
  );
  secret = await ownerKeyOf(dataDir);
  const action = async (name: string, args: unknown): Promise<unknown> => {
    const response = await fetch(`${origin}/api/actions/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    });
    const outcome = ActionOutcomeSchema.parse(await response.json());
    if (!outcome.ok) throw new Error(`action ${name} denied: ${outcome.denial.message}`);
    return outcome.result;
  };
  const grant = TokenGrantSchema.parse(
    await action("core.access.createPrincipal", { name: "terminal-ui-lab", kind: "human" }),
  );
  grantToken = grant.token;
  expectedPrincipalId = grant.principal.id;
  const canvas = ContainerResponseSchema.parse(
    await action("core.index.createContainer", { name: "terminal-ui-lab" }),
  ).container.id;
  let machineId = "";
  await until(
    async () => {
      machineId =
        MachinesResponseSchema.parse(await action("core.machines.list", {})).machines.find(
          (m) => m.online,
        )?.id ?? "";
      return machineId !== "";
    },
    30000,
    "isolated machine online",
  );
  client = new SessionClient({
    url: `${origin.replace("http", "ws")}/ws/session`,
    containerId: canvas,
    token: grantToken,
    reconnect: false,
  });
  await client.connect();
  if (client.self?.id !== expectedPrincipalId)
    throw new Error("SDK session self differs from lab grant");
  observations["sdkIdentity"] = { principalId: client.self.id, matchesGrant: true };
  const a = await client.openTerminal({
    elementId: crypto.randomUUID(),
    cols: 80,
    rows: 24,
    machineId,
  });
  const b = await client.openTerminal({
    elementId: crypto.randomUUID(),
    cols: 80,
    rows: 24,
    machineId,
  });
  if (a.createdBy !== expectedPrincipalId || b.createdBy !== expectedPrincipalId)
    throw new Error("terminal creator differs from lab grant");
  observations["terminalAuthority"] = [a, b].map((t) => ({
    terminalId: t.id,
    createdBy: t.createdBy,
    controllerId: t.controllerId,
    creatorMatchesGrant: t.createdBy === expectedPrincipalId,
  }));
  const placed = PlaceResponseSchema.parse(
    await action("core.space.place", {
      ref: { kind: "terminal", terminalId: b.id },
      destination: {
        kind: "tile",
        containerId: a.containerId,
        targetTileId: ROOT_TILE_ID,
        edge: "right",
      },
    }),
  );
  if (placed.op !== "add_tile") throw new Error("fixture did not form a split composition");
  const primary = await launch("wide", 1440, 900, 1.25);
  const login = async (browser: Browser, name: string): Promise<void> => {
    // The served and selected instance are the same origin: credentialKey uses the bare
    // spelling, with isolation supplied by localStorage's origin. Never seed an owner key.
    await cdp(browser, "Page.addScriptToEvaluateOnNewDocument", {
      source: `if(location.origin===${JSON.stringify(origin)}) localStorage.setItem("manifold.identity",${JSON.stringify(JSON.stringify({ token: grantToken, principal: grant.principal }))});`,
    });
    await browser.goto(`${origin}/p/${a.containerId}`);
    await until(
      () =>
        sessionIdentities.some((s) => s.browser === name && s.matchesGrant && s.type === "init"),
      25000,
      "browser session init matching lab grant",
    );
    if (sessionIdentities.some((s) => s.browser === name && !s.matchesGrant))
      throw new Error(`${name}: mismatched browser identity`);
    await until(
      () =>
        evaluate<boolean>(
          browser,
          "document.querySelectorAll('.composition-view .xterm-rows').length === 2",
        ),
      25000,
      "actual composition terminals",
    );
    await click(browser, ".xterm-host");
    await sleep(1000);
  };
  await login(primary, "wide");
  const firstTerminalId = a.id;
  observations["fixture"] = {
    terminalIds: [firstTerminalId, b.id],
    grantPrincipalId: expectedPrincipalId,
    principal:
      "One human grant shared by SDK and both browser profiles; server session init identities are verified. Owner key is used only for fixture administration.",
  };
  enterPhase("font-zoom");
  await command(primary, workload);
  for (const target of [13, 20, 26, 32, 20, 8, 13]) {
    await font(primary, target);
    await sleep(700);
    await capture(primary, "wide", `font-${target}`);
    if (target === 13 && captures.filter((c) => c.label === "font-13").length === 1) {
      enterPhase("geometry-padding-trial");
      const originalPadding = await evaluate<string[]>(
        primary,
        "Array.from(document.querySelectorAll('.xterm-host'),h=>h.style.padding)",
      );
      let paddingTrialFailed = false;
      let paddingTrialError: unknown;
      try {
        await evaluate(
          primary,
          "(() => {for(const h of document.querySelectorAll('.xterm-host'))h.style.padding='0px';return true;})()",
        );
        await font(primary, 14);
        await font(primary, 13);
        await sleep(700);
        await capture(primary, "wide", "font-13-host-padding-zero");
      } catch (error) {
        paddingTrialFailed = true;
        paddingTrialError = error;
      }
      try {
        await evaluate(
          primary,
          `(() => {const values=${JSON.stringify(originalPadding)};document.querySelectorAll('.xterm-host').forEach((h,i)=>h.style.padding=values[i]);return true;})()`,
        );
        // Do not issue another failing click or replace the original trial error.
        if (!paddingTrialFailed) {
          await font(primary, 14);
          await font(primary, 13);
          await sleep(700);
        }
      } catch (error) {
        if (!paddingTrialFailed) throw error;
        errors.push(`padding trial restoration: ${sanitize(String(error))}`);
      }
      if (paddingTrialFailed) throw paddingTrialError;
      await capture(primary, "wide", "font-13-host-padding-restored");
      observations["paddingTrial"] = {
        intervention:
          "Runtime host inline padding zero, font 14→13 forces first-terminal fit, original inline padding restored then font 14→13",
        productCssChanged: false,
        interpretation:
          "Compare before/zero/restored first-terminal bounds at font 13; no physical paint or native-platform inference.",
      };
      enterPhase("font-zoom");
    }
  }
  // Wait for the finite shell loop before starting a second; no background process is left.
  await sleep(16000);
  enterPhase("divider");
  await command(primary, workload);
  const seam = await evaluate<{ x: number; y: number; column: boolean; extent: number } | null>(
    primary,
    `(() => {const d=document.querySelector('.composition-view [role="separator"]'); if(!d) return null;const r=d.getBoundingClientRect(),p=d.parentElement.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,column:r.width>r.height,extent:r.width>r.height?p.height:p.width};})()`,
  );
  if (seam === null) throw new Error("actual composition divider not found");
  gestureTimeline.push({ label: "divider-press-dispatch-start", observedMs: performance.now() });
  await cdp(primary, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: seam.x,
    y: seam.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  gestureTimeline.push({ label: "divider-press-dispatch-complete", observedMs: performance.now() });
  for (let step = 1; step <= 24; step++) {
    const delta = Math.sin((step / 24) * Math.PI * 2) * seam.extent * 0.18;
    gestureTimeline.push({
      label: `divider-move-${step}-dispatch-start`,
      observedMs: performance.now(),
    });
    await cdp(primary, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: seam.x + (seam.column ? 0 : delta),
      y: seam.y + (seam.column ? delta : 0),
      button: "left",
      buttons: 1,
    });
    gestureTimeline.push({
      label: `divider-move-${step}-dispatch-complete`,
      observedMs: performance.now(),
    });
    await sleep(25);
    if (step % 4 === 0) await capture(primary, "wide", `drag-held-${step}`);
  }
  gestureTimeline.push({ label: "divider-release-dispatch-start", observedMs: performance.now() });
  await cdp(primary, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: seam.x,
    y: seam.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  gestureTimeline.push({
    label: "divider-release-dispatch-complete",
    observedMs: performance.now(),
  });
  await sleep(800);
  await capture(primary, "wide", "drag-settled");
  gestureTimeline.push({
    label: "divider-settled-capture-complete",
    observedMs: performance.now(),
  });
  await sleep(16000);
  enterPhase("same-principal");
  const secondary = await launch("narrow", 1000, 680, 2);
  await login(secondary, "narrow");
  await command(primary, workload);
  for (let round = 0; round < 3; round++) {
    await click(primary, ".xterm-host");
    await font(primary, round % 2 === 0 ? 20 : 13);
    await sleep(700);
    await capture(primary, "wide", `device-${round}-wide-fit`);
    await capture(secondary, "narrow", `device-${round}-wide-fit`);
    await click(secondary, ".xterm-host");
    await font(secondary, round % 2 === 0 ? 32 : 13);
    await sleep(700);
    await capture(primary, "wide", `device-${round}-narrow-fit`);
    await capture(secondary, "narrow", `device-${round}-narrow-fit`);
  }
  await sleep(16000);
  enterPhase("keyboard-dom");
  await font(primary, 13);
  await click(primary, ".xterm-host");
  await sleep(700);
  for (let sample = 0; sample < 5; sample++) {
    const marker = `ECHO_LAB_${sample}`;
    await primary.typeText(`printf '\\n%s%s\\n' ECHO_ LAB_${sample}`);
    await evaluate(
      primary,
      `(() => {window.__terminalLab.armed=${JSON.stringify(marker)};return true;})()`,
    );
    await cdp(primary, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
    await cdp(primary, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await until(
      () =>
        evaluate<boolean>(
          primary,
          `window.__terminalLab.keys.some(s=>s.marker===${JSON.stringify(marker)} && s.visibleMs!==null)`,
        ),
      8000,
      "shell output-only marker DOM mutation",
    );
  }
  await capture(primary, "wide", "keyboard-finished");
} catch (error) {
  errors.push(sanitize(`${phase}: ${error instanceof Error ? error.message : String(error)}`));
}
const timing: Record<string, unknown> = {};
enterPhase("collect-timing");
for (const record of browsers) {
  try {
    const raw = await evaluate<PageTiming | null>(
      record.browser,
      "(() => {const x=window.__terminalLab;if(!x)return null;return {frames:x.frames,longTasks:x.longTasks,keys:x.keys,resizeObservations:x.resizeObservations,pointerEvents:x.pointerEvents,dropped:x.dropped};})()",
    );
    if (raw === null)
      throw new Error("timing instrumentation unavailable; no page samples collected");
    const environment = await evaluate<unknown>(
      record.browser,
      "({userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,timeOriginMs:performance.timeOrigin,longTaskSupported:PerformanceObserver.supportedEntryTypes.includes('longtask')})",
    );
    timing[record.name] = {
      environment,
      frameIntervals: stats(raw.frames),
      longTaskDurations: stats(raw.longTasks.map((x) => x.durationMs)),
      enterToVisibleDom: stats(
        raw.keys.flatMap((x) => (x.visibleMs === null ? [] : [x.visibleMs - x.startMs])),
      ),
      raw,
    };
    const messages = record.browser.drainMessages();
    observations[`${record.name}PageMessageCounts`] = {
      exceptions: messages.filter((m) => m.kind === "exception").length,
      errors: messages.filter((m) => m.level === "error").length,
    };
  } catch (error) {
    errors.push(sanitize(`collect ${record.name}: ${String(error)}`));
  }
}
enterPhase("cleanup");
for (const record of browsers) {
  const cleanup = {
    profileSource: "managed CDP chrome://version #profile_path",
    profile: null as string | null,
    browserCloseAcknowledged: false,
    launcherExited: false,
    profileRemoved: false,
  };
  observations[`${record.name}Cleanup`] = cleanup;
  try {
    record.profile = await browserProfile(record.browser);
    cleanup.profile = record.profile;
  } catch (error) {
    errors.push(
      sanitize(`profile identification ${record.name}: ${String(error)}; profile retained`),
    );
  }
  try {
    const reply = await record.browser.send("Browser.close", {}, false);
    if (Reflect.get(reply, "error") !== undefined) throw new Error("CDP Browser.close failed");
    cleanup.browserCloseAcknowledged = true;
  } catch (error) {
    errors.push(sanitize(`browser close ${record.name}: ${String(error)}; profile retained`));
  }
  try {
    if (record.proc === undefined)
      throw new Error("own launcher handle unavailable; profile retained");
    cleanup.launcherExited = await waitForBrowserExit(record.proc);
    if (!cleanup.launcherExited) {
      record.proc.kill("SIGKILL");
      cleanup.launcherExited = await waitForBrowserExit(record.proc);
      throw new Error(
        `own launcher did not exit after Browser.close; SIGKILL exit observed=${String(cleanup.launcherExited)}; profile retained`,
      );
    }
    if (cleanup.browserCloseAcknowledged && record.profile !== undefined) {
      rmSync(record.profile, { recursive: true, force: true });
      cleanup.profileRemoved = true;
    }
  } catch (error) {
    errors.push(sanitize(`browser cleanup ${record.name}: ${String(error)}`));
  }
  try {
    await record.browser.close();
  } catch (error) {
    errors.push(sanitize(`browser helper close ${record.name}: ${String(error)}`));
  }
}
client?.close();
try {
  if (server !== null) await teardownServer(server, dataDir);
  else if (dataDir !== "") rmSync(dataDir, { recursive: true, force: true });
} catch (error) {
  errors.push(sanitize(`server cleanup: ${String(error)}`));
}
try {
  cleanupDist?.();
  if (!keep && artifacts !== "") rmSync(artifacts, { recursive: true, force: true });
} catch (error) {
  errors.push(sanitize(`artifact cleanup: ${String(error)}`));
}
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: repoRoot,
  stdout: "pipe",
  stderr: "ignore",
});
observations["sessionIdentities"] = sessionIdentities;
observations["phaseTimeline"] = {
  unit: "ms",
  clock: "collecting Bun performance.now; each boundary starts the named phase",
  events: phaseTimeline,
};
observations["captureObserverCost"] = {
  unit: "ms",
  clock: "collecting Bun performance.now",
  dom: stats(captures.map((c) => c.observerCost.domMs)),
  heldDragDom: stats(
    captures.filter((c) => c.label.startsWith("drag-held-")).map((c) => c.observerCost.domMs),
  ),
  screenshots: stats(
    captures.filter((c) => c.screenshot !== undefined).map((c) => c.observerCost.screenshotMs),
  ),
  policy:
    "Held-drag captures are always DOM-only, even with BENCH_TERMINAL_KEEP=1. DOM costs include CDP roundtrip; screenshot costs include CDP and artifact write. Continuous in-page instrumentation cost is not isolated.",
};
observations["gestureTimeline"] = {
  unit: "ms",
  clock:
    "collecting Bun performance.now, same as rawResizeEvents.observedMs; dispatch bounds are not page receipt timestamps",
  events: gestureTimeline,
};
observations["resizeTiming"] = {
  page: "resizeObservations and pointerEvents share browser performance.now; use actual pointerup to quantify ResizeObserver timing",
  wire: "rawResizeEvents include phase and Bun observedMs, correlated to gestureTimeline dispatch bounds; collector delay remains unmeasured",
};
const report =
  sanitize(
    JSON.stringify(
      {
        experiment: "terminal-ui",
        sourceCommit: commit.success ? commit.stdout.toString().trim() : null,
        environment: {
          bun: Bun.version,
          os: platform(),
          release: release(),
          arch: arch(),
          browserMode:
            "headless Chromium, helper uses --disable-gpu; software-GPU results are nonrepresentative",
        },
        workload: {
          fontTargets: [13, 20, 26, 32, 20, 8, 13],
          paddingTrialRefitTargets: [14, 13, 14, 13],
          dividerSteps: 24,
          dividerStepDelayMs: 25,
          samePrincipalRounds: 3,
          keyboardSamples: 5,
          shellGridFramesPerRun: 150,
          shellGridNominalPeriodMs: 100,
          shellGridRuns: 3,
        },
        counts: { wireEvents: wires.length, captures: captures.length },
        timing,
        rawResizeEvents: wires,
        captures,
        observations,
        errors,
        artifactDirectory: keep ? artifacts : null,
        limitations: [
          "Browser-clock Enter event capture to MutationObserver seeing an exact shell-output row is DOM latency, NOT physical paint/input-to-photon. rAF intervals are scheduling intervals, not presented frames.",
          "Resize timestamps are CDP monotonic seconds per browser; observedMs and gesture dispatch bounds share the collecting Bun clock. Page pointer/ResizeObserver timestamps share a separate browser clock. Collector latency is unmeasured; geometry matching is not causal RTT.",
          "Grid captures can intersect partial redraws; compare repeated settled observations before declaring corruption. Inspect raw text, duplicates, bottom marker and unclipped screen bounds together.",
          "Headless Linux viewport/DPR configurations are not native Mac/Windows devices, GPU, network, human perception or Ghostty evidence. SDK and browsers share one human grant, with actual server init identity checks.",
          "Held-drag captures are always DOM-only: no screenshot CDP roundtrip or artifact write occurs between press and release. DOM roundtrip costs are reported per capture; 25ms is requested pacing plus dispatch and DOM overhead, not guaranteed event rate. Continuous ResizeObserver/MutationObserver overhead is not isolated. Shell sleeps and grid generation cost are part of workload.",
          "Only the first terminal receives the workload and font refit; the second provides the real split. Padding intervention affects both hosts but only the first is explicitly refitted. Full browser timings include startup, not phase-isolated benchmarking.",
          "Runtime padding trial is a reversible diagnostic, not a product CSS fix or proof of causality beyond the observed bounds. Raw content is only from disposable fixture terminals.",
          "Cleanup reads only the managed CDP page's chrome://version profile path, strictly validates the isolated /tmp/manifold-verify-digits-digits directory, closes that browser via CDP and waits for its retained launcher. Unknown cleanup failures retain the profile and fail the experiment. No other processes or temporary directories are scanned.",
        ],
      },
      null,
      2,
    ),
  ) + "\n";
// Large stdout writes can stall behind a pipe or be lost on process exit. Commit the
// complete raw report independently; an interrupted write never replaces an older run.
const reportPath =
  process.env["BENCH_TERMINAL_REPORT"] ??
  (artifacts === "" ? join(tmpdir(), `manifold-ui-lab-${process.pid}.json`) : `${artifacts}.json`);
const pendingPath = `${reportPath}.${process.pid}.pending`;
try {
  await Bun.write(pendingPath, report);
  renameSync(pendingPath, reportPath);
} finally {
  rmSync(pendingPath, { force: true });
}
console.log(
  JSON.stringify({
    experiment: "terminal-ui",
    reportPath,
    reportBytes: Buffer.byteLength(report),
    errorCount: errors.length,
    captures: captures.length,
    wireEvents: wires.length,
  }),
);
process.exitCode = errors.length === 0 ? 0 : 1;
