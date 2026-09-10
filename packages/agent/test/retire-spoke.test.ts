import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_HOST_PROTOCOL_VERSION } from "@manifold/protocol";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Scenario = "busy" | "unknown" | "jobs" | "wrong-identity" | "accepted" | "still-enabled"
  | "mismatched-owner" | "owner-propagation" | "transport-propagation"
  | "restart-always" | "restart-override-ignored" | "replacement-generation"
  | "transport-stop-command";
interface State {
  draining: boolean;
  ownerAlive: boolean;
  ownerKilled: boolean;
  acknowledged: boolean;
  transportRunning: boolean;
  transportStarts: number;
  shutdownRequests: number;
  ownerEnabled: boolean;
  transportEnabled: boolean;
  ownerPid: number;
  restart: string;
  restartOverride: string;
  transportRestartOverride: string;
  replacementKilled: boolean;
  dependentAlive: boolean;
}

async function retirement(scenario: Scenario) {
  const directory = mkdtempSync(join(tmpdir(), "manifold-retirement-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const load = (): State => JSON.parse(readFileSync(statePath, "utf8"));
  const save = (state: State) => writeFileSync(statePath, JSON.stringify(state));
  save({
    draining: false, ownerAlive: true, ownerKilled: false, acknowledged: false,
    transportRunning: true, transportStarts: 0, shutdownRequests: 0,
    ownerEnabled: true, transportEnabled: true,
    ownerPid: scenario === "mismatched-owner" ? process.pid + 1 : process.pid,
    restart: "always", restartOverride: "", replacementKilled: false, dependentAlive: true,
    transportRestartOverride: "",
  });
  const ownerKey = "cdef".repeat(16);
  const ownerKeyPath = join(directory, "owner.key");
  writeFileSync(ownerKeyPath, ownerKey, { mode: 0o600 });
  const hostId = "fixture-retained-owner";
  const machineId = "fixture-old-spoke";
  const hub = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${ownerKey}`)
        return new Response(null, { status: 403 });
      const args = await request.json();
      if (new URL(request.url).pathname !== "/api/actions/core.machines.drain" || args.machineId !== machineId)
        return new Response(null, { status: 400 });
      const state = load();
      state.draining = args.draining === true;
      save(state);
      return Response.json(scenario === "unknown"
        ? { ok: false, denial: { rule: "unavailable", message: "inventory unavailable" } }
        : { ok: true, result: { terminalHostId: hostId, draining: state.draining, terminalIds: scenario === "busy" ? ["retained-terminal"] : [] } });
    },
  });
  cleanups.push(() => hub.stop(true));
  const socketPath = join(directory, "owner.sock");
  const peers = new Set<Socket>();
  const server = createServer(socket => {
    peers.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => peers.delete(socket));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const command = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        const state = load();
        let frame: unknown;
        if (command.type === "status_request") {
          frame = {
            type: "status", terminalHostId: hostId,
            terminalHostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            build: "retirement-fixture", pid: process.pid, draining: state.draining,
            transportAttached: state.transportRunning, terminals: [],
          };
        } else if (command.type === "shutdown_request") {
          state.shutdownRequests++;
          if (!state.draining || state.transportRunning || scenario === "jobs") {
            frame = { type: "shutdown_refused", reason: scenario === "jobs" ? "jobs_retained" : "not_draining", terminalIds: [] };
          } else {
            const acknowledgedId = scenario === "wrong-identity" ? "different-owner" : hostId;
            frame = { type: "shutting_down", terminalHostId: acknowledgedId };
            if (acknowledgedId === hostId) {
              state.acknowledged = true;
              state.ownerAlive = false;
              if (state.restart !== "no" || scenario === "replacement-generation") {
                state.ownerAlive = true;
                state.ownerPid++;
              }
            }
          }
        } else {
          socket.destroy();
          continue;
        }
        save(state);
        socket.write(JSON.stringify(frame) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  // Stateful supervisor boundary: stop destroys a still-live owner; disable must
  // actually change the observed state. No host systemd manager is contacted.
  writeFileSync(join(directory, "systemctl"), `#!${process.execPath}
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8"));
const [, op, ...args] = process.argv.slice(2);
if (op === "show") {
  const owner = args[0] === "old-owner.service";
  const running = owner ? state.ownerAlive : state.transportRunning;
  const property = args[1].slice("--property=".length);
  const properties = {
    LoadState: "loaded", ActiveState: running ? "active" : "inactive",
    SubState: running ? "running" : "dead", MainPID: running ? (owner ? String(state.ownerPid) : "102") : "0",
    UnitFileState: (owner ? state.ownerEnabled : state.transportEnabled) ? "enabled" : "disabled",
    ControlGroup: owner ? "/fixture/owner" : "/fixture/transport",
    InvocationID: owner && state.ownerPid !== Number(process.env.FIXTURE_OWNER_PID) && process.env.FIXTURE_SCENARIO === "replacement-generation" ? "b".repeat(32) : "a".repeat(32),
    Restart: owner ? state.restart : (state.transportRestartOverride ? "no" : "always"), RestartForceExitStatus: "",
    DropInPaths: owner ? state.restartOverride : state.transportRestartOverride,
    ConsistsOf: "", BoundBy: (owner && process.env.FIXTURE_SCENARIO === "owner-propagation") || (!owner && process.env.FIXTURE_SCENARIO === "transport-propagation") ? "busy-dependent.service" : "",
    RequiredBy: "", PropagatesStopTo: "", OnSuccess: "", OnFailure: "", TriggeredBy: "",
    SuccessAction: "none", FailureAction: "none", StartLimitAction: "none",
    ExecStop: "", ExecStopPost: !owner && process.env.FIXTURE_SCENARIO === "transport-stop-command" ? "kill-busy-owner" : "",
  };
  if (!(property in properties)) process.exit(1);
  console.log(properties[property]);
} else if (op === "daemon-reload") {
  for (const unit of ["old-owner", "old-transport"]) {
    const directory = process.env.HOME + "/systemd/user/" + unit + ".service.d";
    const overrides = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".conf")) : [];
    const path = overrides.length ? directory + "/" + overrides[0] : "";
    if (unit === "old-owner") {
      state.restartOverride = path;
      state.restart = path && process.env.FIXTURE_SCENARIO !== "restart-override-ignored" ? "no" : "always";
    } else state.transportRestartOverride = path;
  }
  writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
} else {
  for (const unit of args) {
    const owner = unit === "old-owner.service";
    if (op === "stop") {
      if (owner) {
        state.ownerKilled ||= state.ownerAlive;
        state.replacementKilled ||= state.ownerAlive && state.ownerPid !== Number(process.env.FIXTURE_OWNER_PID);
        state.ownerAlive = false;
        if (process.env.FIXTURE_SCENARIO === "owner-propagation") state.dependentAlive = false;
      } else {
        state.transportRunning = false;
        if (process.env.FIXTURE_SCENARIO === "transport-propagation") state.dependentAlive = false;
      }
    } else if (op === "start" && !owner) {
      state.transportRunning = true; state.transportStarts++;
    } else if (op === "disable") {
      if (process.env.FIXTURE_SCENARIO !== "still-enabled") {
        if (owner) state.ownerEnabled = false; else state.transportEnabled = false;
      }
    } else process.exit(1);
  }
  writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
}
`, { mode: 0o700 });
  // Execute the actual streamed public bundle, substituting only the fixture's
  // in-container endpoint and credential path. No credentials enter arguments.
  writeFileSync(join(directory, "docker"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.slice(0, 7).join(" ") !== "exec -i --workdir /app fixture-hub bun -") process.exit(1);
const cli = args.slice(7);
cli[cli.indexOf("--hub") + 1] = process.env.FIXTURE_HUB;
cli[cli.indexOf("--owner-key-file") + 1] = process.env.FIXTURE_KEY_PATH;
const child = Bun.spawn([process.execPath, "-", ...cli], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
`, { mode: 0o700 });
  const child = Bun.spawn([
    "bash", "-c", `
source "$1"; shift
# This fixture covers the supervisor/maintenance flow, not kernel identity.
# retire-spoke-systemd.test.ts exercises the unmodified real transport proof.
prove_transport() { :; }
retirement_main "$@"
`, "retirement-fixture", join(import.meta.dir, "../../../infra/previews/retire-spoke.sh"),
    "--container", "fixture-hub", "--machine-id", machineId, "--terminal-host-id", hostId,
    "--terminal-host-unit", "old-owner.service", "--transport-unit", "old-transport.service",
    "--transport-package", `/nix/store/${"a".repeat(32)}-manifold-agent-fixture`,
    "--socket", socketPath, "--runtime-dir", directory,
  ], {
    env: {
      PATH: `${directory}:${process.env.PATH ?? ""}`, HOME: directory,
      FIXTURE_STATE: statePath, FIXTURE_HUB: hub.url.origin,
      FIXTURE_KEY_PATH: ownerKeyPath, FIXTURE_SCENARIO: scenario,
      FIXTURE_OWNER_PID: String(process.pid),
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stdout + stderr).not.toContain(ownerKey);
  return { code, state: load(), stderr };
}

for (const scenario of ["busy", "unknown"] as const) {
  test(`retirement holds ${scenario} inventory with admission closed and both supervisors untouched`, async () => {
    const { code, state } = await retirement(scenario);
    expect(code).toBe(1);
    expect(state).toMatchObject({ draining: true, ownerAlive: true, ownerKilled: false,
      transportRunning: true, transportStarts: 0, shutdownRequests: 0,
      ownerEnabled: true, transportEnabled: true });
  }, 30_000);
}
for (const scenario of ["jobs", "wrong-identity"] as const) {
  test(`retirement restores transport on ${scenario} shutdown refusal without reopening or killing owner`, async () => {
    const { code, state } = await retirement(scenario);
    expect(code).toBe(1);
    expect(state).toMatchObject({ draining: true, ownerAlive: true, ownerKilled: false,
      transportRunning: true, transportStarts: 1, shutdownRequests: 1,
      ownerEnabled: true, transportEnabled: true });
  }, 30_000);
}
test("only exact atomic shutdown acknowledgement permits stopped and disabled supervisors", async () => {
  const { code, state } = await retirement("accepted");
  expect(code).toBe(0);
  expect(state).toMatchObject({ draining: true, acknowledged: true, ownerAlive: false,
    ownerKilled: false, transportRunning: false, transportStarts: 0,
    ownerEnabled: false, transportEnabled: false });
}, 30_000);
test("successful disable command is insufficient when observed supervisors remain enabled", async () => {
  const { code, state } = await retirement("still-enabled");
  expect(code).toBe(1);
  expect(state).toMatchObject({ acknowledged: true, ownerKilled: false, ownerEnabled: true,
    transportEnabled: true, transportRunning: false });
}, 30_000);

for (const scenario of ["mismatched-owner", "owner-propagation", "transport-propagation", "restart-override-ignored",
  "transport-stop-command"] as const) {
  test(`retirement refuses ${scenario} without stopping an unproved owner or its dependents`, async () => {
    const { code, state } = await retirement(scenario);
    expect(code).toBe(1);
    expect(state).toMatchObject({ ownerAlive: true, ownerKilled: false, dependentAlive: true,
      replacementKilled: false, shutdownRequests: 0, ownerEnabled: true, restart: "always",
      restartOverride: "", transportRestartOverride: "", transportRunning: true });
  }, 30_000);
}
test("Restart=always cannot replace the acknowledged generation during retirement", async () => {
  const { code, state } = await retirement("restart-always");
  expect(code).toBe(0);
  expect(state).toMatchObject({ acknowledged: true, ownerAlive: false, ownerPid: process.pid,
    replacementKilled: false, restart: "always", restartOverride: "", ownerEnabled: false });
}, 30_000);
test("an unexpected replacement after acknowledgement is held and never stopped", async () => {
  const { code, state } = await retirement("replacement-generation");
  expect(code).toBe(1);
  expect(state).toMatchObject({ acknowledged: true, ownerAlive: true, ownerPid: process.pid + 1,
    ownerKilled: false, replacementKilled: false, ownerEnabled: true, restart: "always", restartOverride: "" });
}, 30_000);
