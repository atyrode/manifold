import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TERMINAL_HOST_PROTOCOL_VERSION } from "@manifold/protocol";

// Real Linux children/pidfds and the production maintenance HTTP/Unix protocol.
// Docker is not contacted. The boundary substitutes only container supervision;
// no fake CLI result can stand in for the owner's acknowledgment or actual exit.
const fixture = String.raw`
import importlib.util, json, os, pathlib, subprocess, sys, time
spec = importlib.util.spec_from_file_location("cutover", sys.argv[1])
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
root = pathlib.Path(sys.argv[2])
scenario, bun, bundle, hub, version = sys.argv[3:]
owner_source = r'''
import json, pathlib, socket, sys
root = pathlib.Path(sys.argv[1])
scenario, version = sys.argv[2:]
s = socket.socket(socket.AF_UNIX)
s.bind(str(root / "owner.sock"))
s.listen()
while True:
    peer, _ = s.accept()
    f = peer.makefile("rwb", buffering=0)
    try:
        while True:
            raw = f.readline()
            if not raw: break
            frame = json.loads(raw)
            if frame["type"] == "status_request":
                reply = {"type":"status", "terminalHostId":"fixture-owner", "terminalHostProtocolVersion":int(version), "build":"fixture", "pid":__import__("os").getpid(), "draining":(root / "drained").exists(), "transportAttached":True, "terminals":[]}
            elif frame["type"] == "shutdown_request":
                (root / "shutdown-requested").touch()
                if scenario == "jobs" or not (root / "drained").exists():
                    reply = {"type":"shutdown_refused", "reason":"jobs_retained", "terminalIds":[]}
                elif scenario == "disconnect":
                    peer.close()
                    break
                else:
                    reply = {"type":"shutting_down", "terminalHostId":"wrong-owner" if scenario == "wrong-ack" else "fixture-owner"}
                    f.write((json.dumps(reply) + "\n").encode())
                    if scenario != "wrong-ack":
                        sys.exit(0)
                    continue
            else:
                break
            f.write((json.dumps(reply) + "\n").encode())
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        f.close()
        peer.close()
'''
children = []
def child(args):
    p = subprocess.Popen([sys.executable, "-c", *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    children.append(p)
    return p

def generation(p, wrong=False):
    raw = pathlib.Path(f"/proc/{p.pid}/stat").read_text()
    start = int(raw[raw.rindex(")") + 2:].split()[19])
    return c.Generation(p.pid, start + (1 if wrong else 0))

try:
    owner = child([owner_source, str(root), scenario, version])
    transport = child(["import time; time.sleep(120)"])
    server = child(["import time; time.sleep(120)"])
    extra = child(["import time; time.sleep(120)"]) if scenario == "extra-process" else None
    for _ in range(300):
        if (root / "owner.sock").exists(): break
        time.sleep(.01)
    class Boundary:
        def __init__(self):
            self.evidence = {"machineId":"fixture-machine", "terminalHostId":"fixture-owner"}
            self.phase = "preflight"
            self.owner = generation(owner, scenario == "mismatched-generation")
            self.transport = generation(transport)
            self.server = generation(server)
        def prove(self, phase):
            expected = {"owning":{owner.pid, transport.pid, server.pid}, "owner-exited":{transport.pid,server.pid}, "server-only":{server.pid}}[phase]
            # poll reaps fixture children; live or extra generations are not empty.
            actual = {p.pid for p in children if p.poll() is None}
            c.require(actual == expected)
            for name in ("owner", "transport", "server"):
                process = {"owner":owner,"transport":transport,"server":server}[name]
                if process.pid in expected: getattr(self,name).alive()
        def inhibit_restart(self):
            # These are direct subprocesses, not restarting supervisors.
            self.phase = "restart-inhibited"
        def maintenance(self, op):
            args = [bun, bundle, op]
            if op == "drain":
                args += ["--hub",hub,"--machine-id","fixture-machine","--owner-key-file",str(root / "owner.key")]
            else:
                args += ["--socket",str(root / "owner.sock"),"--terminal-host-id","fixture-owner","--expected-pid",str(owner.pid)]
            return json.loads(c.command(args))
        def remove_empty_container(self):
            c.require(all(p.poll() is not None for p in children))
    outcome = "complete"
    try:
        b = Boundary()
        c.retire(b)
    except Exception:
        outcome = "hold"
    print(json.dumps({"outcome":outcome,"ownerAlive":owner.poll() is None,"transportAlive":transport.poll() is None,"serverAlive":server.poll() is None,"shutdownRequested":(root / "shutdown-requested").exists(),"state":(root / "retained-state").read_text()}))
finally:
    # Test cleanup only, after all observed safety outcomes have been captured.
    for p in children:
        if p.poll() is None: p.terminate()
        p.wait()
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function cutover(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), "manifold-legacy-cutover-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const retained = "identity=unchanged\nterminal-record=retained\njob-record=retained\n";
  writeFileSync(join(directory, "retained-state"), retained);
  const key = "abcd".repeat(16);
  writeFileSync(join(directory, "owner.key"), key, { mode: 0o600 });
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response(null, { status: 403 });
      const body = await request.json();
      if (
        new URL(request.url).pathname !== "/api/actions/core.machines.drain" ||
        body.machineId !== "fixture-machine" ||
        body.draining !== true
      )
        return new Response(null, { status: 400 });
      writeFileSync(join(directory, "drained"), "");
      return Response.json(
        scenario === "unknown"
          ? { ok: false, denial: { rule: "unavailable", message: "inventory unknown" } }
          : {
              ok: true,
              result: {
                terminalHostId: "fixture-owner",
                draining: true,
                terminalIds: scenario === "busy" ? ["retained-terminal"] : [],
              },
            },
      );
    },
  });
  cleanups.push(() => hub.stop(true));
  const entry = join(directory, "entry.ts");
  writeFileSync(
    entry,
    `import { runMaintenanceCLI } from ${JSON.stringify(resolve(import.meta.dir, "../src/maintenance.ts"))}; process.exitCode = await runMaintenanceCLI(process.argv.slice(2));`,
  );
  const bundle = join(directory, "maintenance.js");
  const built = await Bun.build({ entrypoints: [entry], target: "bun" });
  if (!built.success) throw new AggregateError(built.logs);
  await Bun.write(bundle, built.outputs[0]!);
  const process = Bun.spawn(
    [
      "python3",
      "-c",
      fixture,
      resolve(import.meta.dir, "../../../infra/previews/cutover-legacy-preview.py"),
      directory,
      scenario,
      Bun.which("bun")!,
      bundle,
      `http://127.0.0.1:${hub.port}`,
      String(TERMINAL_HOST_PROTOCOL_VERSION),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(`fixture failed: ${stderr}`);
  expect(readFileSync(join(directory, "retained-state"), "utf8")).toBe(retained);
  return JSON.parse(stdout);
}

const linuxTest = process.platform === "linux" ? test : test.skip;
for (const scenario of ["busy", "unknown", "jobs"]) {
  linuxTest(`legacy cutover leaves ${scenario} owner and transport alive`, async () => {
    const result = await cutover(scenario);
    expect(result.outcome).toBe("hold");
    expect(result.ownerAlive).toBe(true);
    expect(result.transportAlive).toBe(true);
    expect(result.serverAlive).toBe(true);
    expect(result.shutdownRequested).toBe(scenario === "jobs");
  });
}
for (const scenario of ["mismatched-generation", "extra-process"]) {
  linuxTest(`legacy cutover refuses ${scenario} before owner shutdown`, async () => {
    const result = await cutover(scenario);
    expect(result.outcome).toBe("hold");
    expect(result.ownerAlive).toBe(true);
    expect(result.transportAlive).toBe(true);
    expect(result.shutdownRequested).toBe(false);
  });
}
for (const scenario of ["wrong-ack", "disconnect"]) {
  linuxTest(`legacy cutover requires exact owner acknowledgment on ${scenario}`, async () => {
    const result = await cutover(scenario);
    expect(result.outcome).toBe("hold");
    expect(result.ownerAlive).toBe(true);
    expect(result.transportAlive).toBe(true);
    expect(result.serverAlive).toBe(true);
  });
}
linuxTest("empty handoff waits for owner self-exit and preserves retained state", async () => {
  const result = await cutover("empty");
  expect(result.outcome).toBe("complete");
  expect(result.shutdownRequested).toBe(true);
  expect(result.ownerAlive).toBe(false);
  expect(result.transportAlive).toBe(false);
  expect(result.serverAlive).toBe(false);
});
