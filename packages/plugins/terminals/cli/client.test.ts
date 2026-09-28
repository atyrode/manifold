import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_TRACE_ID_HEADER,
  PROTOCOL_VERSION,
  TerminalProgramSchema,
  type MachineSummary,
  type TerminalInfo,
} from "@manifold/protocol";
import { runTerminalClient, type TerminalClientStdio } from "./client.ts";

const TOKEN = "private-terminal-bearer-never-print";
const ORIGIN = "http://private-hub.invalid";
const CONTAINER = "private-container";
const DOORS = [
  "core.machines.list",
  "core.terminals.create",
  "core.terminals.take",
  "core.terminals.kill",
];
const PROTOCOL = {
  protocolVersion: PROTOCOL_VERSION,
  actions: DOORS.map((name) => ({
    name,
    title: name,
    caps: [],
    scope: "container",
    input: { type: "object" },
    result: { type: "object" },
  })),
};
const MACHINE: MachineSummary = {
  id: "machine",
  name: "Unix machine",
  online: true,
  terminalExecution: "unconfined",
};
const TERMINAL: TerminalInfo = {
  id: "owned-terminal",
  containerId: CONTAINER,
  name: null,
  machineId: MACHINE.id,
  status: "running",
  exitCode: null,
  exitReason: null,
  readiness: null,
  cols: 80,
  rows: 24,
  controllerId: "terminal-principal",
  createdBy: "terminal-principal",
};
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
});

function mockFetch(handler: (request: Request) => Promise<Response>) {
  const replacement = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)),
    { preconnect: globalThis.fetch.preconnect },
  );
  mocks.push(spyOn(globalThis, "fetch").mockImplementation(replacement));
}

function environment() {
  return { MANIFOLD_URL: ORIGIN, MANIFOLD_CONTAINER: CONTAINER, MANIFOLD_TOKEN: TOKEN };
}

// Exercise the real SessionClient through its existing WebSocket seam. Replies to input
// can arrive synchronously: this is the fast-output race, not a quiet-time simulation.
class Socket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  channel = "";
  attached = false;
  controlled = false;
  inputCount = 0;
  sequence = 7;
  onInput: (text: string, raw: Buffer) => void = () => {};

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame["type"] === "join") {
      this.channel = String(frame["ch"]);
      this.receive({
        type: "init",
        protocolVersion: PROTOCOL_VERSION,
        epoch: "epoch",
        rev: 0,
        doc: "AAA=",
        self: { id: "terminal-principal", kind: "agent", name: "terminal", color: "#112233" },
        selfConnId: "connection",
        selfCaps: ["containers:read", "terminals:spawn", "terminals:write"],
        attendance: [],
        terminals: [],
      });
    } else if (frame["type"] === "terminal_attach") {
      this.attached = true;
      this.receive({
        type: "terminal_snapshot",
        terminalId: TERMINAL.id,
        seq: this.sequence,
        data: Buffer.from("NEVER RETURN SNAPSHOT HISTORY").toString("base64"),
      });
      this.receive({
        type: "terminal_output",
        terminalId: "unrelated-terminal",
        seq: 1,
        data: Buffer.from("NEVER RETURN ANOTHER TERMINAL").toString("base64"),
      });
    } else if (frame["type"] === "terminal_take") {
      this.controlled = true;
      this.receive({
        type: "terminal_event",
        terminalId: TERMINAL.id,
        kind: "controller_changed",
        controllerId: "terminal-principal",
      });
    } else if (frame["type"] === "terminal_input") {
      if (!this.attached || !this.controlled)
        throw new Error("command released before attachment/control");
      this.inputCount++;
      const raw = Buffer.from(String(frame["data"]), "base64");
      this.onInput(raw.toString().trim(), raw);
    }
  }

  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ ch: this.channel, ...frame }) } as MessageEvent);
  }

  output(data: string | Uint8Array) {
    this.receive({
      type: "terminal_output",
      terminalId: TERMINAL.id,
      seq: ++this.sequence,
      data: (typeof data === "string" ? Buffer.from(data) : Buffer.from(data)).toString("base64"),
    });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function harness(
  options: {
    roster?: MachineSummary[];
    create?: (body: unknown) => void;
    kill?: (request: Request) => Response;
    input?: (socket: Socket, nonce: string) => void;
  } = {},
) {
  let socket: Socket | null = null;
  let connections = 0;
  let creates = 0;
  const kills: unknown[] = [];
  const bodies: unknown[] = [];
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/protocol") return Response.json(PROTOCOL);
    if (path.endsWith("core.machines.list"))
      return Response.json(
        { ok: true, result: { machines: options.roster ?? [MACHINE] } },
        { headers: { [ACTION_TRACE_ID_HEADER]: "21" } },
      );
    if (path.endsWith("core.terminals.create")) {
      creates++;
      const body: unknown = await request.json();
      bodies.push(body);
      options.create?.(body);
      return Response.json(
        { ok: true, result: { terminal: TERMINAL, uri: `manifold://terminal/${TERMINAL.id}` } },
        { headers: { [ACTION_TRACE_ID_HEADER]: "22" } },
      );
    }
    if (path.endsWith("core.terminals.kill")) {
      kills.push(await request.json());
      return (
        options.kill?.(request) ??
        Response.json({ ok: true, result: {} }, { headers: { [ACTION_TRACE_ID_HEADER]: "23" } })
      );
    }
    throw new Error("unexpected action");
  });
  return {
    get socket() {
      return socket;
    },
    get connections() {
      return connections;
    },
    get creates() {
      return creates;
    },
    kills,
    bodies,
    factory: (_url: string) => {
      connections++;
      const current = new Socket();
      current.onInput = (nonce) => options.input?.(current, nonce);
      socket = current;
      return current as unknown as WebSocket;
    },
  };
}

describe("terminal-local client boundaries", () => {
  test("discovers machines through a multi-megabyte installed action vocabulary", async () => {
    const catalogue = {
      ...PROTOCOL,
      actions: [
        {
          ...PROTOCOL.actions[0]!,
          input: { type: "object", description: "schema".repeat(1_048_576) },
        },
        ...PROTOCOL.actions.slice(1),
      ],
    };
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/protocol") return Response.json(catalogue);
      if (path.endsWith("core.machines.list"))
        return Response.json(
          { ok: true, result: { machines: [MACHINE] } },
          { headers: { [ACTION_TRACE_ID_HEADER]: "21" } },
        );
      throw new Error("unexpected action");
    });
    let text = "";
    expect(
      await runTerminalClient(["machines"], {
        environment: environment(),
        output: (value) => {
          text = value;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(text).machines[0].id).toBe(MACHINE.id);
  });

  test("rejects protocol skew before admission and never reflects unsafe HTTP errors or inherited values", async () => {
    let skew = true;
    mockFetch(async () =>
      skew
        ? Response.json({ ...PROTOCOL, protocolVersion: PROTOCOL_VERSION + 1 })
        : Response.json(
            { error: { code: "unauthorized", message: `${TOKEN} ${ORIGIN} ${CONTAINER}` } },
            { status: 401 },
          ),
    );
    const replies: string[] = [];
    let connected = false;
    const invoke = () =>
      runTerminalClient(["doctor"], {
        environment: environment(),
        output: (text) => replies.push(text),
        webSocketFactory: () => {
          connected = true;
          throw new Error("must not connect");
        },
      });
    expect(await invoke()).toBe(1);
    expect(JSON.parse(replies[0]!).diagnostic.code).toBe("protocol_mismatch");
    skew = false;
    expect(await invoke()).toBe(1);
    expect(JSON.parse(replies[1]!).diagnostic.code).toBe("auth_refused");
    expect(connected).toBe(false);
    for (const value of [TOKEN, ORIGIN, CONTAINER]) expect(replies.join("")).not.toContain(value);
  });

  test("does not choose between an inherited terminal and Run identity", async () => {
    const inherited: Record<string, string | undefined> = {
      ...environment(),
      MANIFOLD_RUN_TOKEN: "private-run-token",
      MANIFOLD_RUN_ID: "run",
    };
    let text = "";
    const status = await runTerminalClient(["doctor"], {
      environment: inherited,
      output: (value) => {
        text = value;
      },
    });
    expect(status).toBe(1);
    expect(JSON.parse(text).diagnostic.code).toBe("ambiguous_binding");
    expect(text).not.toContain("private-run-token");
    expect(inherited["MANIFOLD_TOKEN"]).toBeUndefined();
    expect(inherited["MANIFOLD_RUN_TOKEN"]).toBeUndefined();
  });

  test("an exact but ambiguous machine name cannot fall back to an online target", async () => {
    const fixture = harness({ roster: [MACHINE, { ...MACHINE, id: "second", online: false }] });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.name, "--", "/bin/true"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
    });
    expect(status).toBe(1);
    expect(JSON.parse(text).diagnostic.code).toBe("machine_ambiguous");
    expect(fixture.creates).toBe(0);
    expect(fixture.connections).toBe(0);
  });

  test("captures same-turn fast output after snapshot/control, strips split framing and preserves a nonzero exit", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`${nonce}\r\n\x1emanifold-`);
        socket.output(`exec:${nonce}\x1frequested\r\n`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 7,
        });
      },
      kill: () => {
        fixture.socket?.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "parked",
        });
        return Response.json(
          { ok: true, result: {} },
          { headers: { [ACTION_TRACE_ID_HEADER]: "23" } },
        );
      },
    });
    let text = "";
    const status = await runTerminalClient(
      ["exec", "--machine", MACHINE.id, "--", "/bin/echo", "literal ; $(not shell)"],
      {
        environment: environment(),
        output: (value) => {
          text = value;
        },
        webSocketFactory: fixture.factory,
      },
    );
    const reply = JSON.parse(text);
    expect(status).toBe(7);
    expect(Buffer.from(reply.output.data, "base64").toString()).toBe("requested\r\n");
    expect(reply.output.complete).toBe(true);
    expect(reply.completion).toEqual({ state: "exited", exitCode: 7, reason: null });
    expect(reply.controller).toBe("acquired");
    expect(reply.cleanup).toMatchObject({ state: "confirmed", via: "kill", traceId: 23 });
    expect(fixture.kills).toEqual([{ terminalId: TERMINAL.id }]);
  });

  test("output overflow retains exactly its byte cap and is failure even if a zero exit follows", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`\x1emanifold-exec:${nonce}\x1fabcdef`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 0,
        });
      },
    });
    let text = "";
    const status = await runTerminalClient(
      ["exec", "--machine", MACHINE.id, "--max-output-bytes", "3", "--", "/bin/echo", "abcdef"],
      {
        environment: environment(),
        output: (value) => {
          text = value;
        },
        webSocketFactory: fixture.factory,
      },
    );
    const reply = JSON.parse(text);
    expect(status).toBe(125);
    expect(reply.ok).toBe(false);
    expect(Buffer.from(reply.output.data, "base64").toString()).toBe("abc");
    expect(reply.output.complete).toBe(false);
    expect(reply.completion.exitCode).toBe(0);
    expect(reply.diagnostic.code).toBe("output_limit");
    expect(reply.cleanup.state).toBe("confirmed");
  });

  test("interruption during birth waits for ownership then kills only the returned terminal without releasing argv", async () => {
    const controller = new AbortController();
    const fixture = harness({
      create: () => controller.abort(),
      kill: (request) => {
        expect(request.signal.aborted).toBe(false);
        return Response.json(
          { ok: true, result: {} },
          { headers: { [ACTION_TRACE_ID_HEADER]: "24" } },
        );
      },
    });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.id, "--", "/bin/true"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
      signal: controller.signal,
    });
    const reply = JSON.parse(text);
    expect(status).toBe(130);
    expect(reply.diagnostic.code).toBe("cancelled");
    expect(reply.cleanup).toMatchObject({ state: "confirmed", traceId: 24 });
    expect(fixture.socket?.inputCount).toBe(0);
    expect(fixture.kills).toEqual([{ terminalId: TERMINAL.id }]);
  });

  test("revoked source never replays or claims success when cleanup is refused", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`\x1emanifold-exec:${nonce}\x1fpartial`);
        socket.close(4403, `unsafe upstream ${TOKEN}`);
      },
      kill: () => Response.json({ error: { code: "forbidden", message: TOKEN } }, { status: 403 }),
    });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.id, "--", "/bin/true"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
    });
    const reply = JSON.parse(text);
    expect(status).toBe(1);
    expect(reply.diagnostic.code).toBe("source_revoked");
    expect(reply.completion.state).toBe("unknown");
    expect(reply.output.complete).toBe(false);
    expect(reply.cleanup.state).toBe("unconfirmed");
    expect(text).not.toContain(TOKEN);
    expect(fixture.connections).toBe(1);
    expect(fixture.creates).toBe(1);
  });

  test("a clean-exit removal event confirms cleanup despite a racing kill refusal", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`\x1emanifold-exec:${nonce}\x1ffast`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 0,
        });
      },
      kill: () => {
        queueMicrotask(() =>
          fixture.socket?.receive({
            type: "terminal_event",
            terminalId: TERMINAL.id,
            kind: "parked",
          }),
        );
        return Response.json(
          { ok: false, denial: { rule: "refused", message: "terminal not found" } },
          { headers: { [ACTION_TRACE_ID_HEADER]: "25" } },
        );
      },
    });
    let text = "";
    const status = await runTerminalClient(
      ["exec", "--machine", MACHINE.id, "--", "/bin/echo", "fast"],
      {
        environment: environment(),
        output: (value) => {
          text = value;
        },
        webSocketFactory: fixture.factory,
      },
    );
    const reply = JSON.parse(text);
    expect(status).toBe(0);
    expect(reply.ok).toBe(true);
    expect(Buffer.from(reply.output.data, "base64").toString()).toBe("fast");
    expect(reply.cleanup).toEqual({
      state: "confirmed",
      via: "removal_event",
      traceId: null,
      processStopped: "confirmed",
    });
    expect(reply.receipts).toContainEqual({
      door: "core.terminals.kill",
      ok: false,
      rule: "refused",
      traceId: 25,
    });
  });

  test("zero exit without the owned start frame cannot certify requested command output", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`${nonce}\r\nwrapper failed`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 0,
        });
        socket.receive({ type: "terminal_event", terminalId: TERMINAL.id, kind: "parked" });
      },
    });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.id, "--", "/bin/true"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
    });
    const reply = JSON.parse(text);
    expect(status).toBe(1);
    expect(reply.diagnostic.code).toBe("output_missing");
    expect(reply.output).toMatchObject({ bytes: 0, complete: false });
    expect(reply.completion).toMatchObject({
      state: "unknown",
      exitCode: null,
      terminalExitCode: 0,
    });
    expect(reply.cleanup.state).toBe("confirmed");
    expect(fixture.kills).toEqual([]);
  });

  test("an executable option cannot become a successful no-command shell exec", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`\x1emanifold-exec:${nonce}\x1f`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 0,
        });
        socket.receive({ type: "terminal_event", terminalId: TERMINAL.id, kind: "parked" });
      },
    });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.id, "--", "--"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
    });
    expect(status).toBe(1);
    expect(JSON.parse(text).diagnostic.code).toBe("invalid_arguments");
  });

  test("a broker-inferred missing terminal cannot prove the process stopped", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`\x1emanifold-exec:${nonce}\x1fpartial`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: null,
        });
      },
    });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.id, "--", "/bin/true"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
    });
    const reply = JSON.parse(text);
    expect(status).toBe(1);
    expect(reply.completion).toMatchObject({ state: "unknown", exitCode: null });
    expect(reply.cleanup).toMatchObject({ state: "confirmed", processStopped: "unconfirmed" });
  });

  test("a restart during cleanup cannot replace the owned command's exit or cessation evidence", async () => {
    const fixture = harness({
      input: (socket, nonce) => {
        socket.output(`\x1emanifold-exec:${nonce}\x1fowned failure`);
        socket.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 7,
        });
      },
      kill: () => {
        fixture.socket?.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "restarted",
        });
        fixture.socket?.output("unrelated replacement");
        fixture.socket?.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "exited",
          exitCode: 0,
        });
        fixture.socket?.receive({
          type: "terminal_event",
          terminalId: TERMINAL.id,
          kind: "parked",
        });
        return Response.json(
          { ok: false, denial: { rule: "refused", message: "controller changed" } },
          { headers: { [ACTION_TRACE_ID_HEADER]: "26" } },
        );
      },
    });
    let text = "";
    const status = await runTerminalClient(["exec", "--machine", MACHINE.id, "--", "/bin/false"], {
      environment: environment(),
      output: (value) => {
        text = value;
      },
      webSocketFactory: fixture.factory,
    });
    const reply = JSON.parse(text);
    expect(status).not.toBe(0);
    expect(reply.ok).toBe(false);
    expect(reply.completion.exitCode).toBe(7);
    expect(reply.output.complete).toBe(false);
    expect(Buffer.from(reply.output.data, "base64").toString()).toBe("owned failure");
    expect(reply.cleanup.processStopped).toBe("unconfirmed");
  });
});

const frame = (key: string, body: string) => `\x1emanifold-ssh:${key}:${body}\x1f`;

/** stderr as the wrapper writes it: `od -A n -v -t x1` lines, five (80 bytes) per frame. */
function stderrFrames(key: string, bytes: Buffer): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 80) {
    let body = "";
    for (const byte of bytes.subarray(at, at + 80))
      body += ` ${byte.toString(16).padStart(2, "0")}`;
    text += frame(key, `e:${body}`);
  }
  return text;
}

function exited(socket: Socket, exitCode: number | null) {
  socket.receive({ type: "terminal_event", terminalId: TERMINAL.id, kind: "exited", exitCode });
  if (exitCode === 0)
    socket.receive({ type: "terminal_event", terminalId: TERMINAL.id, kind: "parked" });
}

/** The launched argv, validated by the same schema the hub applies to it. */
function programArgv(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("program" in body))
    throw new Error("create request without a program");
  return TerminalProgramSchema.parse(body.program).argv;
}

function createdArgv(fixture: { bodies: unknown[] }): string[] {
  return programArgv(fixture.bodies.at(-1));
}

interface LocalStdio {
  readonly stdio: TerminalClientStdio;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** How often the client asked for local stdin. */
  readonly reads: number;
}

function localStdio(stdin: Uint8Array | "open" = new Uint8Array(), terminal = false): LocalStdio {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let reads = 0;
  return {
    get stdout() {
      return Buffer.concat(out);
    },
    get stderr() {
      return Buffer.concat(err);
    },
    get reads() {
      return reads;
    },
    stdio: {
      stdout: (bytes) => void out.push(Buffer.from(bytes)),
      stderr: (bytes) => void err.push(Buffer.from(bytes)),
      stdinIsTerminal: terminal,
      readStdin: (maxBytes) => {
        reads++;
        if (stdin === "open") return Promise.withResolvers<never>().promise;
        return Promise.resolve(stdin.length > maxBytes ? null : stdin);
      },
    },
  };
}

function ssh(args: string[], local: LocalStdio, webSocketFactory?: (url: string) => WebSocket) {
  return runTerminalClient(["ssh", ...args], {
    environment: environment(),
    output: () => {
      throw new Error("ssh never prints a JSON envelope");
    },
    stdio: local.stdio,
    ...(webSocketFactory === undefined ? {} : { webSocketFactory }),
  });
}

/** Plays the pipe wrapper's side of the frame protocol; `run` is the command after `s`. */
function pipeWrapper(
  fixture: { bodies: unknown[] },
  run: (socket: Socket, key: string, stdin: Buffer) => void,
) {
  let key: string | null = null;
  let awaiting = false;
  const stdin: Buffer[] = [];
  const violations: string[] = [];
  return {
    violations,
    get chunks() {
      return stdin.length;
    },
    input(socket: Socket, text: string) {
      if (key === null) {
        const [nonce, secret] = text.split(" ");
        key = secret ?? "";
        socket.output(`${nonce} ${key}\r\n`); // a raced echo of the barrier line
        if (createdArgv(fixture)[5] === "i") {
          awaiting = true;
          socket.output(frame(key, "r"));
        } else {
          socket.output(frame(key, "s"));
          run(socket, key, Buffer.alloc(0));
        }
        return;
      }
      if (!awaiting) violations.push("input without a pending r frame");
      awaiting = false;
      if (text === "\x04") {
        socket.output(frame(key, "s"));
        run(socket, key, Buffer.concat(stdin));
        return;
      }
      if (!text.endsWith("\n\x04")) violations.push("chunk not closed by ^D");
      if (text.split("\n").some((line) => line.length > 76)) violations.push("line over 76");
      stdin.push(Buffer.from(text.slice(0, -1).replace(/\n/g, ""), "base64"));
      awaiting = true;
      socket.output(frame(key, "r"));
    },
  };
}

/** Starts at once in either mode and exits 0; for tests about what is launched. */
function quickExit(socket: Socket, text: string) {
  const [nonce, key] = text.split(" ");
  socket.output(key === undefined ? `\x1emanifold-exec:${nonce}\x1f` : frame(key, "s"));
  exited(socket, 0);
}

describe("manifold ssh", () => {
  test("writes remote stdout raw and framed stderr separately, byte for byte, across split frames", async () => {
    const stderr = Buffer.concat([
      Buffer.from("err\r\n"),
      Buffer.from([0x1e, 0x1f, 0x00, 0xff]),
      randomBytes(300),
    ]);
    let expected = Buffer.alloc(0);
    const fixture = harness({ input: (socket, text) => wrapper.input(socket, text) });
    const wrapper = pipeWrapper(fixture, (socket, key) => {
      const stdout = [
        Buffer.from("out\r\n"),
        Buffer.from([0x00, 0xff, 0x1e, 0x1f, 0x0d, 0x0a, 0x0d]),
        Buffer.from("\x1emanifold-ssh:0000:e:41\x1f"), // another key: plain stdout
        Buffer.from(frame(key, "e:zz")), // malformed: the command's own bytes
        Buffer.from("tail\x1e"), // an RS held back until the authoritative exit
      ];
      expected = Buffer.concat(stdout);
      const stream = Buffer.concat([
        stdout[0]!,
        Buffer.from(stderrFrames(key, stderr.subarray(0, 150))),
        stdout[1]!,
        stdout[2]!,
        stdout[3]!,
        Buffer.from(stderrFrames(key, stderr.subarray(150))),
        stdout[4]!,
      ]);
      for (let at = 0; at < stream.length; at += 7) socket.output(stream.subarray(at, at + 7));
      exited(socket, 0);
    });
    const local = localStdio();
    expect(await ssh([MACHINE.id, "printf", "anything"], local, fixture.factory)).toBe(0);
    expect(local.stdout).toEqual(expected);
    expect(local.stderr).toEqual(stderr);
    expect(createdArgv(fixture).slice(3)).toEqual([
      "manifold-ssh",
      expect.any(String),
      "n",
      "printf anything",
    ]);
  });

  test.each([0, 1, 42, 137])("exits with the owner-reported remote status %d", async (code) => {
    const fixture = harness({ input: (socket, text) => wrapper.input(socket, text) });
    const wrapper = pipeWrapper(fixture, (socket) => {
      socket.output("x");
      exited(socket, code);
    });
    const local = localStdio();
    expect(await ssh([MACHINE.id, "exit", String(code)], local, fixture.factory)).toBe(code);
    expect(local.stdout.toString()).toBe("x");
    expect(local.stderr.length).toBe(0);
  });

  const refusedForbidden = () =>
    Response.json({ error: { code: "forbidden", message: TOKEN } }, { status: 403 });
  test.each<{
    code: string;
    args?: string[];
    roster?: MachineSummary[];
    kill?: () => Response;
    run?: (socket: Socket) => void;
    release?: (socket: Socket, text: string) => void;
    stdout?: string;
  }>([
    {
      code: "timed_out",
      args: ["--timeout-ms", "50"],
      run: (socket) => socket.output("partial"),
      stdout: "partial",
    },
    { code: "machine_not_found", roster: [] },
    { code: "completion_unknown", run: (socket) => exited(socket, null) },
    { code: "cleanup_unconfirmed", run: (socket) => exited(socket, 7), kill: refusedForbidden },
    {
      code: "output_limit",
      args: ["--max-output-bytes", "3"],
      run: (socket) => {
        socket.output("abcdef");
        exited(socket, 0);
      },
      stdout: "abc",
    },
    { code: "connection_lost", run: (socket) => socket.close(1006) },
    {
      code: "target_missing_od",
      release: (socket, text) => {
        socket.output(frame(text.split(" ")[1]!, "m:od"));
        exited(socket, 125);
      },
    },
    {
      code: "output_missing",
      release: (socket) => {
        socket.output("stty: invalid argument\r\n");
        exited(socket, 125);
      },
    },
  ])("a Manifold-side $code exits 255 with one diagnostic line", async (scenario) => {
    const fixture = harness({
      ...(scenario.roster === undefined ? {} : { roster: scenario.roster }),
      ...(scenario.kill === undefined ? {} : { kill: scenario.kill }),
      input: (socket, text) => (scenario.release ?? wrapper.input)(socket, text),
    });
    const wrapper = pipeWrapper(fixture, (socket) => scenario.run?.(socket));
    const local = localStdio();
    const args = [...(scenario.args ?? []), MACHINE.id, "true"];
    expect(await ssh(args, local, fixture.factory)).toBe(255);
    expect(local.stderr.toString()).toMatch(new RegExp(`^manifold: ${scenario.code}: [^\\n]+\\n$`));
    expect(local.stderr.toString()).not.toContain(TOKEN);
    expect(local.stdout.toString()).toBe(scenario.stdout ?? "");
  });

  test("forwards piped stdin in paced ^D-closed chunks before the command starts", async () => {
    const input = randomBytes(200_000);
    const fixture = harness({ input: (socket, text) => wrapper.input(socket, text) });
    const wrapper = pipeWrapper(fixture, (socket, _key, stdin) => {
      socket.output(stdin);
      exited(socket, 0);
    });
    const local = localStdio(input);
    expect(await ssh([MACHINE.id, "cat"], local, fixture.factory)).toBe(0);
    expect(local.stdout).toEqual(input);
    expect(wrapper.violations).toEqual([]);
    expect(wrapper.chunks).toBe(3);
    expect(createdArgv(fixture)[5]).toBe("i");
  });

  test.each<[string, string[], Uint8Array, boolean, number]>([
    ["-n", ["-n"], new Uint8Array([1, 2, 3]), false, 0],
    ["a terminal stdin", [], new Uint8Array([1, 2, 3]), true, 0],
    ["an empty stdin", [], new Uint8Array(), false, 1],
  ])("gives the command /dev/null for %s", async (_name, flags, stdin, terminal, reads) => {
    const fixture = harness({ input: quickExit });
    const local = localStdio(stdin, terminal);
    expect(await ssh([...flags, MACHINE.id, "cat"], local, fixture.factory)).toBe(0);
    expect(local.reads).toBe(reads);
    expect(createdArgv(fixture)[5]).toBe("n");
  });

  test("oversized or unfinished stdin is refused before any network or birth", async () => {
    const requests: string[] = [];
    mockFetch(async (request) => {
      requests.push(request.url);
      throw new Error("no request expected");
    });
    const oversized = localStdio(new Uint8Array(11));
    expect(await ssh(["--max-input-bytes", "10", MACHINE.id, "cat"], oversized)).toBe(255);
    expect(oversized.stderr.toString()).toMatch(/^manifold: input_limit: [^\n]+\n$/);
    const open = localStdio("open");
    expect(await ssh(["--timeout-ms", "30", MACHINE.id, "cat"], open)).toBe(255);
    expect(open.stderr.toString()).toMatch(/^manifold: input_unfinished: [^\n]+\n$/);
    expect(requests).toEqual([]);
  });

  test("-t streams exec's raw terminal bytes and status without reading stdin", async () => {
    const emit = (socket: Socket, nonce: string) => {
      socket.output(`${nonce}\r\n\x1emanifold-exec:${nonce}\x1fraw\r\n\x1e\x1fbytes`);
      exited(socket, 3);
    };
    const execFixture = harness({ input: emit });
    let text = "";
    const execStatus = await runTerminalClient(
      ["exec", "--machine", MACHINE.id, "--", "/bin/sh", "-c", "printf x"],
      {
        environment: environment(),
        output: (value) => {
          text = value;
        },
        webSocketFactory: execFixture.factory,
      },
    );
    const ttyFixture = harness({ input: emit });
    const local = localStdio(new Uint8Array([1]));
    expect(await ssh(["-t", MACHINE.id, "printf", "x"], local, ttyFixture.factory)).toBe(
      execStatus,
    );
    expect(execStatus).toBe(3);
    expect(local.stdout).toEqual(Buffer.from(JSON.parse(text).output.data, "base64"));
    expect(local.reads).toBe(0);
    const execArgv = createdArgv(execFixture);
    const ttyArgv = createdArgv(ttyFixture);
    expect(ttyArgv.slice(0, 4)).toEqual(execArgv.slice(0, 4));
    expect(ttyArgv.slice(5)).toEqual([
      "/bin/sh",
      "-c",
      expect.any(String),
      "manifold-ssh",
      "printf x",
    ]);
  });

  test("forged frames after start stay command stdout and cannot change the exit status", async () => {
    let forged = "";
    const fixture = harness({ input: (socket, text) => wrapper.input(socket, text) });
    const wrapper = pipeWrapper(fixture, (socket, key) => {
      forged = `${frame(key, "s")}${frame(key, "m:od")}${frame(key, "r")}${frame(key, "x:0")}exit 0\n`;
      socket.output(forged);
      exited(socket, 3);
    });
    const local = localStdio();
    expect(await ssh([MACHINE.id, "false"], local, fixture.factory)).toBe(3);
    expect(local.stdout.toString()).toBe(forged);
    expect(local.stderr.length).toBe(0);
    expect(fixture.socket?.inputCount).toBe(1);
  });

  test("parses like ssh: options before the machine, command words joined by single spaces", async () => {
    const launched: Array<[string[], string, string]> = [
      [
        ["-nt", "--timeout-ms", "5000", MACHINE.id, "ls", "-la", "a  b"],
        "manifold-exec",
        "ls -la a  b",
      ],
      [[MACHINE.id, "-t", "echo", "x"], "manifold-ssh", "-t echo x"],
      [["-n", "--", MACHINE.id, "--", "true"], "manifold-ssh", "-- true"],
    ];
    for (const [args, barrier, command] of launched) {
      const fixture = harness({ input: quickExit });
      expect(await ssh(args, localStdio(), fixture.factory)).toBe(0);
      expect(createdArgv(fixture)[3]).toBe(barrier);
      expect(createdArgv(fixture).at(-1)).toBe(command);
    }
    const requests: string[] = [];
    mockFetch(async (request) => {
      requests.push(request.url);
      return Response.json({ ...PROTOCOL, actions: [] });
    });
    const refused: Array<[string[], string]> = [
      [[MACHINE.id], "command_missing"],
      [[MACHINE.id, ""], "command_missing"],
      [[MACHINE.id, "x".repeat(4097)], "command_too_long"],
      [[], "invalid_arguments"],
      [["-n"], "invalid_arguments"],
      [["-x", MACHINE.id, "true"], "invalid_arguments"],
      [["-", MACHINE.id, "true"], "invalid_arguments"],
      [["--cwd", "/", MACHINE.id, "true"], "invalid_arguments"],
      [["--timeout-ms", "1", "--timeout-ms", "2", MACHINE.id, "true"], "invalid_arguments"],
      [["--timeout-ms", "0", MACHINE.id, "true"], "invalid_arguments"],
      [["--max-input-bytes", "16777217", MACHINE.id, "true"], "invalid_arguments"],
      [["--receipt", "-n", MACHINE.id, "true"], "invalid_arguments"],
    ];
    for (const [args, code] of refused) {
      const local = localStdio();
      expect(await ssh(args, local)).toBe(255);
      expect(local.stderr.toString()).toMatch(new RegExp(`^manifold: ${code}: [^\\n]+\\n$`));
    }
    expect(requests).toEqual([]);
  });

  test("--receipt writes the result once with mode 0600 and never replaces an existing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manifold-ssh-receipt-"));
    try {
      const path = join(dir, "receipt.json");
      const fixture = harness({ input: quickExit });
      expect(
        await ssh(["--receipt", path, MACHINE.id, "true"], localStdio(), fixture.factory),
      ).toBe(0);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const receipt = JSON.parse(await readFile(path, "utf8"));
      expect(receipt).toMatchObject({
        type: "ssh",
        ok: true,
        terminalId: TERMINAL.id,
        output: { mode: "pipes", bytes: 0, complete: true },
        completion: { state: "exited", exitCode: 0 },
        cleanup: { state: "confirmed", via: "removal_event" },
      });
      expect(receipt.receipts).toContainEqual({
        door: "core.terminals.create",
        ok: true,
        traceId: 22,
      });
      const again = localStdio();
      expect(await ssh(["--receipt", path, MACHINE.id, "true"], again, fixture.factory)).toBe(255);
      expect(again.stderr.toString()).toMatch(/^manifold: receipt_unavailable: [^\n]+\n$/);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
      const link = join(dir, "link.json");
      await symlink(join(dir, "target.json"), link);
      expect(
        await ssh(["--receipt", link, MACHINE.id, "true"], localStdio(), fixture.factory),
      ).toBe(255);
      expect(await Bun.file(join(dir, "target.json")).exists()).toBe(false);
      expect(fixture.creates).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

/** A hub fake whose one terminal is a real PTY running exactly the client's argv. */
function ptyHarness() {
  let socket: Socket | null = null;
  let child: Bun.Subprocess | null = null;
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname;
    const headers = (traceId: string) => ({ headers: { [ACTION_TRACE_ID_HEADER]: traceId } });
    if (path === "/api/protocol") return Response.json(PROTOCOL);
    if (path.endsWith("core.machines.list"))
      return Response.json({ ok: true, result: { machines: [MACHINE] } }, headers("21"));
    if (path.endsWith("core.terminals.create")) {
      const argv = programArgv(await request.json());
      const closed = Promise.withResolvers<void>();
      const spawned = Bun.spawn(argv, {
        terminal: {
          cols: 80,
          rows: 24,
          // Bytes before attachment are the snapshot's history, never live output.
          data: (_terminal, bytes) => {
            if (socket?.attached) socket.output(bytes);
          },
          exit: () => closed.resolve(),
        },
      });
      child = spawned;
      // Like the agent: completion follows the drained PTY, never precedes its bytes.
      void Promise.all([spawned.exited, closed.promise]).then(() => {
        exited(socket!, spawned.signalCode === null ? spawned.exitCode : null);
      });
      return Response.json(
        { ok: true, result: { terminal: TERMINAL, uri: `manifold://terminal/${TERMINAL.id}` } },
        headers("22"),
      );
    }
    if (path.endsWith("core.terminals.kill")) {
      child?.kill("SIGKILL");
      return Response.json({ ok: true, result: {} }, headers("23"));
    }
    throw new Error("unexpected action");
  });
  return (_url: string) => {
    const current = new Socket();
    current.onInput = (_text, raw) => child?.terminal?.write(raw);
    socket = current;
    return current as unknown as WebSocket;
  };
}

describe("manifold ssh wrapper in a real PTY", () => {
  test("keeps stdio off the terminal, forwards binary stdin and separates exact concurrent stdout/stderr", async () => {
    const input = randomBytes(150_000);
    const local = localStdio(input);
    const command = `tee /dev/stderr; printf 'err\\036\\037\\r\\n\\000' >&2; printf '\\377\\r\\n'; for f in 0 1 2; do if [ -t $f ]; then printf T; else printf P; fi; done; exit 42`;
    expect(await ssh([MACHINE.id, command], local, ptyHarness())).toBe(42);
    expect(local.stdout).toEqual(
      Buffer.concat([input, Buffer.from([0xff, 0x0d, 0x0a]), Buffer.from("PPP")]),
    );
    expect(local.stderr).toEqual(Buffer.concat([input, Buffer.from("err\x1e\x1f\r\n\x00")]));
  });

  test("reports a signal death as 128+N without leaking the wrapper's job notice", async () => {
    const local = localStdio();
    expect(await ssh([MACHINE.id, "kill -9 $$"], local, ptyHarness())).toBe(137);
    expect(local.stdout.length).toBe(0);
    expect(local.stderr.length).toBe(0);
  });

  test("-t runs the command on the terminal with merged raw terminal bytes", async () => {
    const local = localStdio(new Uint8Array([1]));
    const command = `for f in 0 1 2; do if [ -t $f ]; then printf T; else printf P; fi; done; echo; exit 3`;
    expect(await ssh(["-t", MACHINE.id, command], local, ptyHarness())).toBe(3);
    expect(local.stdout.toString()).toBe("TTT\r\n");
    expect(local.reads).toBe(0);
  });
});
