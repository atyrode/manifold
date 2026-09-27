import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  ACTION_TRACE_ID_HEADER,
  PROTOCOL_VERSION,
  type MachineSummary,
  type TerminalInfo,
} from "@manifold/protocol";
import { runTerminalClient } from "./client.ts";

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
  for (const mock of mocks.splice(0)) mock.mockRestore();
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
  onInput: (nonce: string) => void = () => {};

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
      this.onInput(Buffer.from(String(frame["data"]), "base64").toString().trim());
    }
  }

  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ ch: this.channel, ...frame }) } as MessageEvent);
  }

  output(data: string) {
    this.receive({
      type: "terminal_output",
      terminalId: TERMINAL.id,
      seq: ++this.sequence,
      data: Buffer.from(data).toString("base64"),
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
    create?: () => void;
    kill?: (request: Request) => Response;
    input?: (socket: Socket, nonce: string) => void;
  } = {},
) {
  let socket: Socket | null = null;
  let connections = 0;
  let creates = 0;
  const kills: unknown[] = [];
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
      options.create?.();
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
