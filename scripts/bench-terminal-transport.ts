/** Localhost-only SDK → broker → real PTY experiment. No browser/paint claims.
 * bun scripts/bench-terminal-transport.ts
 * Optional BENCH_RTT_SAMPLES (20), BENCH_RESIZES (12), BENCH_BULK_LINES (512),
 * BENCH_BULK_WIDTH (256), BENCH_TIMEOUT_MS (10000). Hard caps keep runs finite.
 * Requires the repository's Bun dependencies and POSIX stty. No production sessions.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, platform, release, arch } from "node:os";
import { join } from "node:path";
import { SessionClient } from "../packages/sdk/src/index.ts";
import {
  createContainer,
  enrollMachine,
  mintToken,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../packages/testkit/src/index.ts";

function integer(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer in 1..${String(max)}`);
  }
  return value;
}
const workload = {
  rttSamples: integer("BENCH_RTT_SAMPLES", 20, 200),
  resizes: integer("BENCH_RESIZES", 12, 100),
  bulkLines: integer("BENCH_BULK_LINES", 512, 4096),
  bulkWidth: integer("BENCH_BULK_WIDTH", 256, 1024),
  timeoutMs: integer("BENCH_TIMEOUT_MS", 10_000, 30_000),
  sizes: [
    { cols: 96, rows: 28 },
    { cols: 132, rows: 40 },
  ],
};
const epoch = performance.now();
const now = (): number => performance.now() - epoch;
const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};
const fatal: string[] = [];
const clients: SessionClient[] = [];
const captures: Capture[] = [];
let server: TestServer | undefined;
let agent: TestAgent | undefined;
let fixtureDir: string | undefined;
let phase = "bootstrap";
let stopping = false;
const identity = { samePrincipal: false, distinctTransports: false };
const rtt: { index: number; sender: string; sentAtMs: number; receivedAtMs: number; ms: number }[] =
  [];
const resizeSamples: {
  index: number;
  sender: string;
  cols: number;
  rows: number;
  sentAtMs: number;
  receivedAtMs: number;
  ms: number;
  redraw: string;
}[] = [];
const snapshotProbes: {
  viewer: string;
  phase: string;
  seq: number;
  containsLatestGeometry: boolean;
}[] = [];
const throughput: Record<string, unknown>[] = [];

interface Frame {
  kind: "output" | "snapshot";
  seq: number;
  atMs: number;
  bytes: number;
  end: number;
}
interface Snapshot {
  phase: string;
  seq: number;
  atMs: number;
  base64: string;
  text: string;
}
class Capture {
  text = "";
  frames: Frame[] = [];
  snapshots: Snapshot[] = [];
  geometries: { cols: number | undefined; rows: number | undefined; atMs: number }[] = [];
  lastSeq: number | undefined;
  offs: (() => void)[];
  constructor(
    readonly label: string,
    client: SessionClient,
    terminalId: string,
  ) {
    this.offs = [
      client.on("terminal_snapshot", (message) => {
        if (message.terminalId !== terminalId) return;
        const bytes = Buffer.from(message.data, "base64");
        const atMs = now();
        this.lastSeq = message.seq;
        this.snapshots.push({
          phase,
          seq: message.seq,
          atMs,
          base64: message.data,
          text: bytes.toString("utf8"),
        });
        this.frames.push({
          kind: "snapshot",
          seq: message.seq,
          atMs,
          bytes: bytes.length,
          end: this.text.length,
        });
      }),
      client.on("terminal_output", (message) => {
        if (message.terminalId !== terminalId) return;
        const bytes = Buffer.from(message.data, "base64");
        if (this.text.length + bytes.length > 16 * 1024 * 1024 || this.frames.length >= 100_000) {
          fatal.push(`${label}: capture bound exceeded`);
          client.close();
          return;
        }
        check(
          this.lastSeq !== undefined && message.seq === this.lastSeq + 1,
          `${label}: noncontiguous stream at seq ${String(message.seq)}, prior ${String(this.lastSeq)}`,
        );
        this.lastSeq = message.seq;
        // Fixture emits ASCII only, so string offsets equal received byte offsets.
        this.text += bytes.toString("utf8");
        this.frames.push({
          kind: "output",
          seq: message.seq,
          atMs: now(),
          bytes: bytes.length,
          end: this.text.length,
        });
      }),
      client.on("terminal_event", (message) => {
        if (message.terminalId === terminalId && message.kind === "resized") {
          this.geometries.push({ cols: message.cols, rows: message.rows, atMs: now() });
        }
        if (!stopping && message.terminalId === terminalId && message.kind === "exited") {
          fatal.push(`${label}: fixture exited unexpectedly`);
        }
      }),
    ];
    captures.push(this);
  }
  async marker(marker: string, offset = 0): Promise<{ atMs: number; index: number }> {
    return await waitFor(
      () => {
        if (fatal.length > 0) throw new Error("transport or fixture error");
        const index = this.text.indexOf(marker, offset);
        if (index < 0) return false;
        const frame = this.frames.find(
          (entry) => entry.kind === "output" && entry.end >= index + marker.length,
        );
        if (frame === undefined) throw new Error("marker has no receive frame");
        return { atMs: frame.atMs, index };
      },
      workload.timeoutMs,
      2,
    );
  }
}

// stty queries the actual PTY geometry, not SDK/server metadata. Its spawn overhead is
// deliberately included in SIGWINCH-to-redraw measurements and reported as a limitation.
const fixture = String.raw`
import { writeSync } from "node:fs";
const emit = (text: string): void => {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(1, bytes, offset, bytes.length - offset);
};
const size = (): { rows: number; cols: number } => {
  const result = Bun.spawnSync(["stty", "size"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) process.exit(2);
  const [rows, cols] = result.stdout.toString().trim().split(/\s+/).map(Number);
  if (!rows || !cols) process.exit(3);
  return { rows, cols };
};
let redrawSeq = 0;
const redraw = (): void => {
  const { rows, cols } = size();
  redrawSeq += 1;
  emit("\x1b[2J\x1b[H@@G:" + redrawSeq + ":" + cols + "x" + rows + "@@" +
    "\x1b[2;1Hcursor-positioned redraw\x1b[" + rows + ";" + Math.max(1, cols - 5) + "HEDGE\x1b[3;1H@@D:" + cols + "x" + rows + "@@");
};
process.stdin.setRawMode(true);
if (Bun.spawnSync(["stty", "-echo", "-opost"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" }).exitCode !== 0) process.exit(7);
process.stdin.resume();
process.on("SIGWINCH", redraw);
let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString("utf8");
  for (;;) {
    const end = pending.indexOf("\n");
    if (end < 0) break;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const [command, id, a, b] = line.split(" ");
    if (command === "ping") emit("@@P:" + id + "@@");
    else if (command === "draw") redraw();
    else if (command === "bulk") {
      const count = Number(a), width = Number(b);
      if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isInteger(width) || width < 1 || width > 1024) process.exit(4);
      emit("@@BEGIN:" + id + "@@");
      for (let index = 0; index < count; index += 1) {
        emit("@@B:" + id + ":" + index + "@@" + "x".repeat(width) + "\r\n");
      }
      emit("@@END:" + id + "@@");
    } else if (command === "quit") process.exit(0);
    else process.exit(5);
  }
});
redraw();
// Also finite if the parent is interrupted before ordinary teardown.
setTimeout(() => process.exit(6), 180_000);
`;

function summary(samples: number[]): Record<string, number | null> {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number | null =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    count: samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), workload.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function run(): Promise<void> {
  fixtureDir = await mkdtemp(join(tmpdir(), "manifold-transport-"));
  const fixturePath = join(fixtureDir, "fixture.ts");
  await Bun.write(fixturePath, fixture);
  server = await startServer({
    dataDir: join(fixtureDir, "server"),
    ownerKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
  });
  const enrolled = await enrollMachine(server, "transport-benchmark");
  agent = await startAgent({
    serverUrl: server.url,
    machineToken: enrolled.machineToken,
    name: "transport-benchmark",
  });
  const room = await createContainer(server, "transport-benchmark", "composition");
  const grant = await mintToken(server, {
    principal: { kind: "human", name: "transport-benchmark", color: "#334455" },
    caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
  });
  async function viewer(): Promise<SessionClient> {
    if (server === undefined) throw new Error("server unavailable");
    // A DISTINCT factory identity bypasses SDK pooling, but the canonical SDK still
    // owns all connection state; both real sockets authenticate with the SAME grant.
    const client = new SessionClient({
      url: server.wsUrl,
      containerId: room.id,
      token: grant.token,
      reconnect: false,
      webSocketFactory: (url) => new WebSocket(url),
    });
    clients.push(client);
    client.on("error", (message) => {
      fatal.push(`SDK error: ${message.code}`);
    });
    client.on("status", (status) => {
      if (!stopping && status === "closed") fatal.push("SDK connection closed");
    });
    await bounded(client.connect());
    return client;
  }
  const a = await viewer();
  const terminal = await a.openTerminal({
    elementId: "transport-fixture",
    placement: "tile",
    cols: 80,
    rows: 24,
    machineId: enrolled.machineId,
    program: { argv: [process.execPath, fixturePath] },
    timeoutMs: workload.timeoutMs,
  });
  const ca = new Capture("A", a, terminal.id);
  a.attachTerminal(terminal.id);
  await waitFor(() => ca.snapshots.length > 0, workload.timeoutMs, 2);
  // Explicit redraw after attachment makes setup independent of initial snapshot timing.
  a.sendTerminalInput(terminal.id, "draw\n");
  await ca.marker("x24@@");
  phase = "resize-before-fresh-viewer";
  a.resizeTerminal(terminal.id, 96, 28);
  await ca.marker("96x28@@");
  const b = await viewer();
  identity.samePrincipal = a.self?.id === grant.principal.id && b.self?.id === grant.principal.id;
  identity.distinctTransports =
    a.transportId !== null && b.transportId !== null && a.transportId !== b.transportId;
  check(identity.samePrincipal, "viewers do not share principal");
  check(identity.distinctTransports, "viewers do not use distinct connections");
  const cb = new Capture("B", b, terminal.id);
  b.attachTerminal(terminal.id);
  await waitFor(() => cb.snapshots.length > 0, workload.timeoutMs, 2);
  const fresh = cb.snapshots[0];
  if (fresh === undefined) throw new Error("fresh snapshot missing");
  snapshotProbes.push({
    viewer: "B",
    phase,
    seq: fresh.seq,
    containsLatestGeometry: fresh.text.includes("96x28@@"),
  });
  check(fresh.text.includes("96x28@@"), "fresh snapshot lacks prior geometry redraw marker");

  phase = "sequential-input-rtt";
  for (let index = 0; index < workload.rttSamples; index += 1) {
    const sender = index % 2 === 0 ? a : b;
    const offsetA = ca.text.length,
      offsetB = cb.text.length;
    const sentAtMs = now();
    sender.sendTerminalInput(terminal.id, `ping ${String(index)}\n`);
    const [received] = await Promise.all([
      ca.marker(`@@P:${String(index)}@@`, offsetA),
      cb.marker(`@@P:${String(index)}@@`, offsetB),
    ]);
    rtt.push({
      index,
      sender: sender === a ? "A" : "B",
      sentAtMs,
      receivedAtMs: received.atMs,
      ms: received.atMs - sentAtMs,
    });
  }
  phase = "alternating-same-principal-resize";
  for (let index = 0; index < workload.resizes; index += 1) {
    // B starts with the size DIFFERENT from setup, then A takes it back.
    const sender = index % 2 === 0 ? b : a;
    const size = workload.sizes[index % 2 === 0 ? 1 : 0];
    if (size === undefined) throw new Error("size unavailable");
    const offsetA = ca.text.length,
      offsetB = cb.text.length;
    const sentAtMs = now();
    sender.resizeTerminal(terminal.id, size.cols, size.rows);
    const marker = `@@D:${String(size.cols)}x${String(size.rows)}@@`;
    const [received] = await Promise.all([ca.marker(marker, offsetA), cb.marker(marker, offsetB)]);
    const redraw = ca.text.slice(offsetA, received.index + marker.length);
    resizeSamples.push({
      index,
      sender: sender === a ? "A" : "B",
      ...size,
      sentAtMs,
      receivedAtMs: received.atMs,
      ms: received.atMs - sentAtMs,
      redraw,
    });
  }
  phase = "reattach-already-resized-viewer";
  const before = ca.snapshots.length;
  a.attachTerminal(terminal.id);
  await waitFor(() => ca.snapshots.length > before, workload.timeoutMs, 2);
  const current = ca.snapshots.at(-1);
  const lastSize = resizeSamples.at(-1);
  if (current === undefined || lastSize === undefined) throw new Error("reattach evidence missing");
  const latest = `${String(lastSize.cols)}x${String(lastSize.rows)}@@`;
  snapshotProbes.push({
    viewer: "A",
    phase,
    seq: current.seq,
    containsLatestGeometry: current.text.includes(latest),
  });
  check(current.text.includes(latest), "reattached snapshot lacks latest redraw marker");

  phase = "bounded-output-throughput";
  const expected =
    "@@BEGIN:bulk@@" +
    Array.from(
      { length: workload.bulkLines },
      (_unused, index) => `@@B:bulk:${String(index)}@@${"x".repeat(workload.bulkWidth)}\r\n`,
    ).join("") +
    "@@END:bulk@@";
  const offsets = [ca.text.length, cb.text.length];
  const fenceOffsets: number[] = [];
  const sentAtMs = now();
  a.sendTerminalInput(
    terminal.id,
    `bulk bulk ${String(workload.bulkLines)} ${String(workload.bulkWidth)}\n`,
  );
  for (const [index, capture] of [ca, cb].entries()) {
    const offset = offsets[index];
    if (offset === undefined) throw new Error("bulk offset unavailable");
    const end = await capture.marker("@@END:bulk@@", offset);
    fenceOffsets.push(end.index + "@@END:bulk@@".length);
    const received = capture.text.slice(offset, end.index + "@@END:bulk@@".length);
    const begin = await capture.marker("@@BEGIN:bulk@@", offset);
    const durationMs = end.atMs - sentAtMs;
    const exact = received === expected;
    check(
      exact,
      `${capture.label}: throughput bytes differ (loss, duplication, order or unexpected PTY transformation)`,
    );
    const markers = [...received.matchAll(/@@B:bulk:(\d+)@@/g)].map((match) => Number(match[1]));
    const ordering =
      markers.length === workload.bulkLines &&
      markers.every((value, position) => value === position);
    check(ordering, `${capture.label}: throughput marker ordering differs`);
    throughput.push({
      viewer: capture.label,
      sentAtMs,
      firstMarkerAtMs: begin.atMs,
      lastMarkerAtMs: end.atMs,
      commandToLastByteMs: durationMs,
      firstToLastMarkerMs: end.atMs - begin.atMs,
      receivedBytes: Buffer.byteLength(received),
      expectedBytes: Buffer.byteLength(expected),
      exactBytes: exact,
      sha256: new Bun.CryptoHasher("sha256").update(received).digest("hex"),
      expectedSha256: new Bun.CryptoHasher("sha256").update(expected).digest("hex"),
      markerCount: markers.length,
      markers,
      exactMarkerOrdering: ordering,
      commandToLastByteBytesPerSecond: Buffer.byteLength(received) / (durationMs / 1000),
    });
  }
  // Fence both streams so late duplicated/unexpected bytes before the fence are visible.
  a.sendTerminalInput(terminal.id, "ping fence\n");
  for (const [index, capture] of [ca, cb].entries()) {
    const offset = fenceOffsets[index];
    if (offset === undefined) throw new Error("fence offset unavailable");
    const received = await capture.marker("@@P:fence@@", offset);
    check(received.index === offset, `${capture.label}: unexpected bytes after bulk end`);
  }
  check(
    ca.geometries.length === workload.resizes + 1,
    "A geometry event count differs from commands",
  );
  check(
    cb.geometries.length === workload.resizes,
    "B geometry event count differs from commands since connection",
  );
}

let exitSignal: string | undefined;
const abort = (): void => {
  exitSignal = "SIGINT/SIGTERM";
  fatal.push("interrupted");
};
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  // Do not race teardown against unresolved fixture creation: the run observes fatal
  // at its next bounded marker wait, then its single owner closes every resource.
  await run();
} catch {
  // Fixture helpers may include credential-bearing ready logs in errors. Never print
  // their exception text or causes; report safe stage/codes, preserve failure exit status.
  fatal.push(`experiment failed in ${phase}${exitSignal === undefined ? "" : " (interrupted)"}`);
} finally {
  stopping = true;
  for (const capture of captures) for (const off of capture.offs) off();
  for (const client of clients) client.close();
  try {
    await agent?.stop();
  } catch {
    fatal.push("agent cleanup failed");
  }
  try {
    await server?.stop();
  } catch {
    fatal.push("server cleanup failed");
  }
  if (fixtureDir !== undefined) {
    try {
      await rm(fixtureDir, { recursive: true, force: true });
    } catch {
      fatal.push("temporary directory cleanup failed");
    }
  }
  if (abort !== undefined) {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: join(import.meta.dir, ".."),
  stdout: "pipe",
  stderr: "ignore",
});
console.log(
  JSON.stringify(
    {
      experiment: "terminal-transport-real-pty",
      sourceCommit: commit.exitCode === 0 ? commit.stdout.toString().trim() : null,
      environment: {
        bun: Bun.version,
        os: platform(),
        release: release(),
        arch: arch(),
        browser: null,
        viewport: null,
        dpr: null,
        transport: "two localhost SDK WebSockets, one principal",
      },
      workload,
      metrics: {
        inputToOutputCallbackMs: summary(rtt.map((sample) => sample.ms)),
        resizeCommandToRedrawCallbackMs: summary(resizeSamples.map((sample) => sample.ms)),
      },
      raw: {
        rtt,
        resizeSamples,
        throughput,
        snapshotProbes,
        viewers: captures.map((capture) => ({
          viewer: capture.label,
          frames: capture.frames,
          geometries: capture.geometries,
          snapshots: capture.snapshots.map(({ text: _text, ...snapshot }) => snapshot),
          geometryRedrawMarkers: [...capture.text.matchAll(/@@G:(\d+):(\d+)x(\d+)@@/g)].map(
            (match) => ({
              sequence: Number(match[1]),
              cols: Number(match[2]),
              rows: Number(match[3]),
            }),
          ),
        })),
      },
      correctness: {
        identity,
        failures,
        errors: fatal,
        ok: failures.length === 0 && fatal.length === 0,
      },
      limitations: [
        "SDK output callback timestamps, not physical paint, input-to-photon, browser fitting, UX quality or native parity.",
        "Resize latency includes fixture SIGWINCH handling and a stty subprocess querying actual PTY geometry; geometry events are broker acknowledgments, not PTY completion.",
        "RTT destination is viewer A for alternating A/B inputs; both viewers must receive each marker before the next command.",
        "Snapshots are serialized screen state, not original bytes; marker presence and sequence continuity do not prove browser reflow or absence of duplicate rendered TUI rows.",
        "Modest no-contention localhost workload; no slow reader, queue saturation, reconnect, WAN, concurrent resize race, browser paint or production-load claim.",
        "Throughput includes command transit and production, PTY, headless-mirror and SDK work; a single bounded batch per viewer is not a steady-state bandwidth estimate.",
      ],
    },
    null,
    2,
  ),
);
if (failures.length > 0 || fatal.length > 0) process.exitCode = 1;
