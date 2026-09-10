import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TERMINAL_HOST_FRAME_BYTES, TERMINAL_HOST_PROTOCOL_VERSION } from "@manifold/protocol";

// Only disposable fixture credentials and loopback/Unix servers enter these process tests.
const OWNER_KEY = "a451".repeat(16);
const MACHINE_ID = "maintenance-fixture-machine";
const HOST_ID = "maintenance-fixture-owner";
let directory: string;
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "manifold-maintenance-"));
  writeFileSync(join(directory, "owner.key"), `${OWNER_KEY}\n`, { mode: 0o600 });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<Result> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "main.ts"), "--maintenance", ...args],
    {
      cwd: directory,
      env: { HOME: directory, PATH: process.env.PATH ?? "", ...extraEnv },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill();
    await child.exited;
  });
  // Kill only this run-owned fixture child if the public command loses its bounded wait.
  // Fake timers cannot advance a separately spawned Bun process's platform clock.
  const timer = setTimeout(() => child.kill(), 35_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// Assert the public HOLD envelope without pinning optional typed refusal fields.

function hold(result: Result, command: string, reason: string) {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.endsWith("\n")).toBe(true);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, command, hold: true, reason });
  expect(result.stderr).not.toContain(OWNER_KEY);
}

function admissionArgs(command: "drain" | "reopen", hub: string) {
  return [
    command,
    "--hub",
    hub,
    "--machine-id",
    MACHINE_ID,
    "--owner-key-file",
    join(directory, "owner.key"),
  ];
}

function httpFixture(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => server.stop(true));
  return server.url.origin;
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    type: "status",
    terminalHostId: HOST_ID,
    terminalHostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
    build: "offline-fixture",
    pid: process.pid,
    draining: true,
    transportAttached: true,
    terminals: [],
    ...overrides,
  };
}

function send(socket: Socket, frame: unknown) {
  socket.write(`${JSON.stringify(frame)}\n`);
}

async function ownerFixture(onCommand: (type: unknown, socket: Socket) => void) {
  const path = join(directory, "owner.sock");
  const peers = new Set<Socket>();
  const commands: unknown[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    peers.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => peers.delete(socket));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const frame: unknown = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        commands.push(frame);
        onCommand(
          typeof frame === "object" && frame !== null && "type" in frame ? frame.type : undefined,
          socket,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    args: ["shutdown", "--socket", path, "--terminal-host-id", HOST_ID],
    commands,
    connections: () => connections,
  };
}

test("a retained IPC 1 owner can acknowledge its own empty shutdown without an execution declaration", async () => {
  const owner = await ownerFixture((command, socket) => {
    if (command === "status_request") send(socket, status({ terminalHostProtocolVersion: 1 }));
    else if (command === "shutdown_request")
      send(socket, { type: "shutting_down", terminalHostId: HOST_ID });
  });
  const result = await cli(owner.args);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    command: "shutdown",
    terminalHostId: HOST_ID,
  });
});

for (const httpStatus of [200, 403]) {
  test(`HTTP ${httpStatus} refusal cannot reflect the file credential into CLI output`, async () => {
    let requests = 0;
    let authorized = false;
    const hub = httpFixture(async (request) => {
      requests++;
      authorized = request.headers.get("authorization") === `Bearer ${OWNER_KEY}`;
      const reflected = `remote secret ${request.headers.get("authorization")}`;
      return Response.json(
        httpStatus === 200
          ? { ok: false, denial: { rule: "forbidden", message: reflected } }
          : { error: { code: "forbidden", message: reflected } },
        { status: httpStatus },
      );
    });
    const result = await cli(admissionArgs("drain", hub));
    hold(result, "drain", httpStatus === 200 ? "action_refused" : "request_failed");
    expect(result.stderr).not.toContain("remote secret");
    expect(result.stderr).not.toContain("Bearer");
    expect(authorized).toBe(true);
    expect(requests).toBe(1); // A refusal never causes an automatic retry or reopen.
  });
}

test("drain and explicit reopen affect only admission on the named machine", async () => {
  let draining = false;
  const requests: unknown[] = [];
  const hub = httpFixture(async (request) => {
    const args: unknown = await request.json();
    requests.push({ method: request.method, path: new URL(request.url).pathname, args });
    if (typeof args !== "object" || args === null || !("draining" in args))
      return new Response(null, { status: 400 });
    draining = args.draining === true;
    return Response.json({
      ok: true,
      result: { terminalHostId: HOST_ID, draining, terminalIds: ["still-retained"] },
    });
  });
  for (const command of ["drain", "reopen"] as const) {
    const result = await cli(admissionArgs(command, hub));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      command,
      machineId: MACHINE_ID,
      terminalHostId: HOST_ID,
      draining: command === "drain",
      terminalIds: ["still-retained"],
    });
    expect(draining).toBe(command === "drain");
  }
  expect(requests).toEqual(
    [true, false].map((value) => ({
      method: "POST",
      path: "/api/actions/core.machines.drain",
      args: { machineId: MACHINE_ID, draining: value },
    })),
  );
});

test("a mismatched or malformed drain acknowledgement holds without reversing a possibly persisted latch", async () => {
  for (const response of [
    { terminalHostId: HOST_ID, draining: false, terminalIds: [] },
    { terminalHostId: HOST_ID, draining: true },
  ]) {
    let requests = 0;
    const hub = httpFixture(() => {
      requests++;
      return Response.json({ ok: true, result: response });
    });
    hold(
      await cli(admissionArgs("drain", hub)),
      "drain",
      response.draining ? "invalid_response" : "drain_state_mismatch",
    );
    expect(requests).toBe(1);
  }
});

test("malformed flags and credential-bearing URLs never reach the hub or use ambient credentials", async () => {
  let requests = 0;
  const hub = httpFixture(() => {
    requests++;
    return new Response(null, { status: 500 });
  });
  const valid = admissionArgs("drain", hub);
  const malformed = [
    valid.slice(0, -2),
    [...valid, "--machine-id", "other"],
    [...valid, "--socket", join(directory, "owner.sock")],
    [...valid, "--owner-key", OWNER_KEY],
    [...valid, "--terminal-host"],
    admissionArgs("drain", hub.replace("http://", `http://owner:${OWNER_KEY}@`)),
    admissionArgs("drain", `${hub}/?key=${OWNER_KEY}`),
    admissionArgs("drain", `${hub}/#${OWNER_KEY}`),
  ];
  for (const args of malformed) {
    hold(
      await cli(args, { MANIFOLD_OWNER_KEY_FILE: join(directory, "owner.key") }),
      "drain",
      "invalid_arguments",
    );
  }
  expect(requests).toBe(0);
});

test("an unavailable explicit key cannot fall back to an ambient valid key", async () => {
  let requests = 0;
  const hub = httpFixture(() => {
    requests++;
    return new Response(null, { status: 500 });
  });
  const args = admissionArgs("drain", hub);
  args[args.length - 1] = join(directory, `missing-${OWNER_KEY}`);
  hold(
    await cli(args, { MANIFOLD_OWNER_KEY_FILE: join(directory, "owner.key") }),
    "drain",
    "credential_unavailable",
  );
  expect(requests).toBe(0);
});

for (const [overrides, reason] of [
  [{ terminalHostId: "different-owner" }, "owner_identity_mismatch"],
  [{ terminalHostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION + 1 }, "owner_protocol_mismatch"],
] as const) {
  test(`${reason} prevents every shutdown or transport-seat request`, async () => {
    const owner = await ownerFixture((type, socket) => {
      if (type === "status_request") send(socket, status(overrides));
    });
    hold(await cli(owner.args), "shutdown", reason);
    expect(owner.commands).toEqual([{ type: "status_request" }]);
    expect(owner.connections()).toBe(1);
  });
}

for (const reason of ["not_draining", "terminals_retained", "jobs_retained"] as const) {
  test(`${reason} is an atomic HOLD even when the preceding status looked empty`, async () => {
    const owner = await ownerFixture((type, socket) => {
      if (type === "status_request") send(socket, status());
      if (type === "shutdown_request")
        send(socket, {
          type: "shutdown_refused",
          reason,
          terminalIds: reason === "terminals_retained" ? ["raced-terminal"] : [],
        });
    });
    hold(await cli(owner.args), "shutdown", reason);
    expect(owner.commands).toEqual([{ type: "status_request" }, { type: "shutdown_request" }]);
    expect(owner.connections()).toBe(1);
  });
}

test("disconnect after shutdown request is not a positive acknowledgement and never reconnects", async () => {
  const owner = await ownerFixture((type, socket) => {
    if (type === "status_request") send(socket, status());
    if (type === "shutdown_request") socket.end();
  });
  hold(await cli(owner.args), "shutdown", "owner_disconnected");
  expect(owner.commands).toEqual([{ type: "status_request" }, { type: "shutdown_request" }]);
  expect(owner.connections()).toBe(1);
});

test("only a matching positive shutdown acknowledgement succeeds on the status connection", async () => {
  const owner = await ownerFixture((type, socket) => {
    if (type === "status_request") {
      // A real socket may split a frame anywhere, including immediately before the newline.
      const frame = JSON.stringify(status());
      socket.write(frame.slice(0, 17));
      socket.write(frame.slice(17));
      socket.write("\n");
    }
    if (type === "shutdown_request")
      socket.end(`${JSON.stringify({ type: "shutting_down", terminalHostId: HOST_ID })}\n`);
  });
  const result = await cli(owner.args);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    command: "shutdown",
    terminalHostId: HOST_ID,
  });
  expect(owner.commands).toEqual([{ type: "status_request" }, { type: "shutdown_request" }]);
  expect(owner.connections()).toBe(1);
});

test("a different owner's shutdown acknowledgement holds rather than authorizing replacement", async () => {
  const owner = await ownerFixture((type, socket) => {
    if (type === "status_request") send(socket, status());
    if (type === "shutdown_request")
      send(socket, { type: "shutting_down", terminalHostId: "replacement-owner" });
  });
  hold(await cli(owner.args), "shutdown", "owner_identity_mismatch");
  expect(owner.connections()).toBe(1);
});

test("a shutdown acknowledgement before identity proof grants no shutdown authority", async () => {
  const owner = await ownerFixture((type, socket) => {
    if (type === "status_request") send(socket, { type: "shutting_down", terminalHostId: HOST_ID });
  });
  hold(await cli(owner.args), "shutdown", "unexpected_owner_event");
  expect(owner.commands).toEqual([{ type: "status_request" }]);
});

test("an oversized owner frame holds without echoing its contents or requesting shutdown", async () => {
  const owner = await ownerFixture((type, socket) => {
    if (type === "status_request")
      socket.write(
        OWNER_KEY.repeat(Math.ceil((MAX_TERMINAL_HOST_FRAME_BYTES + 1) / OWNER_KEY.length)),
      );
  });
  hold(await cli(owner.args), "shutdown", "invalid_response");
  expect(owner.commands).toEqual([{ type: "status_request" }]);
});

// This is intentionally a real deadline: fake timers in this test cannot control the CLI process.
test("an owner that never acknowledges shutdown times out once without retry or reopen", async () => {
  const owner = await ownerFixture((type, socket) => {
    if (type === "status_request") send(socket, status());
  });
  hold(await cli(owner.args), "shutdown", "owner_timeout");
  expect(owner.commands).toEqual([{ type: "status_request" }, { type: "shutdown_request" }]);
  expect(owner.connections()).toBe(1);
}, 40_000);
