import { describe, expect, test } from "bun:test";
import {
  AdvertisedTerminalSchema,
  AgentMessageSchema,
  ClientMessageBodySchema,
  MACHINE_PROTOCOL_COMPAT_VERSIONS,
  MAX_TERMINAL_ARGV_ITEMS,
  MAX_TERMINAL_CWD_CHARS,
  MAX_TERMINAL_ENV_KEYS,
  PROTOCOL_VERSION,
  ServerMessageBodySchema,
  ServerToAgentMessageSchema,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TERMINAL_RESTART_PROTOCOL_VERSION,
  TerminalHostStatusSchema,
  type TerminalProgram,
} from "@manifold/protocol";

/**
 * The launch overrides a `terminal_open` may carry, and the shared shapes used by both wires.
 * The lifecycle a program runs under is the agent's and broker's to prove; this file proves
 * what the FRAME admits and refuses.
 */
describe("terminal_open launch overrides", () => {
  const argv: TerminalProgram["argv"] = ["/bin/sh", "-c", 'printf "%s" ""', ""];
  const open = {
    type: "terminal_open" as const,
    elementId: "el1",
    cols: 80,
    rows: 24,
    program: { argv },
    env: { CODE_TEST: "x", _UNDERSCORE_FIRST: "" },
  };
  const openWith = (patch: Record<string, unknown>): boolean =>
    ClientMessageBodySchema.safeParse({ ...open, ...patch }).success;

  test("both fields round-trip, and absence is still the pre-v22 frame", () => {
    expect(ClientMessageBodySchema.parse(open)).toEqual(open);
    const plain = { type: "terminal_open" as const, elementId: "el1", cols: 80, rows: 24 };
    expect(ClientMessageBodySchema.parse(plain)).toEqual(plain);
  });

  test("the server's own env prefix is refused by SHAPE, before any merge order applies", () => {
    /*
      A plugin that tries to hand a PTY its own MANIFOLD_TOKEN is told `invalid` at the frame
      rather than silently losing to the fixed keys. The broker's merge order makes the same
      rule true a second way; this is the one a caller can observe.
    */
    expect(openWith({ env: { MANIFOLD_TOKEN: "forged" } })).toBe(false);
    expect(openWith({ env: { MANIFOLD_TEST: "x" } })).toBe(false);
  });

  test("env keys are upper-case POSIX names, bounded in count", () => {
    for (const key of ["lower", "WITH-DASH", "1LEADING", "", "A B"]) {
      expect(openWith({ env: { [key]: "x" } })).toBe(false);
    }
    const atCap = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_ENV_KEYS }, (_, i) => [`K${i}`, "v"]),
    );
    expect(openWith({ env: atCap })).toBe(true);
    expect(openWith({ env: { ...atCap, ONE_MORE: "v" } })).toBe(false);
  });

  test("argv[0] is the one item that may not be empty, and the list is bounded", () => {
    // `""` is a legal ARGUMENT — `cmd ""` is how a program is told "the empty string".
    expect(openWith({ program: { argv: [] } })).toBe(false);
    expect(openWith({ program: { argv: [""] } })).toBe(false);
    expect(openWith({ program: { argv: ["/bin/true", ""] } })).toBe(true);
    const atCap = ["/bin/sh", ...Array<string>(MAX_TERMINAL_ARGV_ITEMS - 1).fill("x")];
    expect(openWith({ program: { argv: atCap } })).toBe(true);
    expect(openWith({ program: { argv: [...atCap, "x"] } })).toBe(false);
  });

  test("cwd keeps its launch semantics and bound on both wires", () => {
    const atCap = "x".repeat(MAX_TERMINAL_CWD_CHARS);
    const overCap = `${atCap}x`;
    const accepted = ["relative/project", "/absolute/project", ""];
    for (const cwd of accepted) expect(openWith({ cwd })).toBe(true);
    expect(openWith({ cwd: atCap })).toBe(true);
    expect(openWith({ cwd: overCap })).toBe(false);

    const create = {
      type: "create" as const,
      terminalId: "t1",
      cols: 80,
      rows: 24,
      env: {},
    };
    for (const cwd of accepted) {
      expect(ServerToAgentMessageSchema.safeParse({ ...create, cwd }).success).toBe(true);
    }
    expect(ServerToAgentMessageSchema.safeParse({ ...create, cwd: atCap }).success).toBe(true);
    expect(ServerToAgentMessageSchema.safeParse({ ...create, cwd: overCap }).success).toBe(false);
  });

  test("the machine wire carries the same program shape verbatim", () => {
    const create = {
      type: "create" as const,
      terminalId: "t1",
      cols: 80,
      rows: 24,
      env: { CODE_TEST: "x", MANIFOLD_TOKEN: "minted" },
      program: open.program,
    };
    expect(ServerToAgentMessageSchema.parse(create)).toEqual(create);
    expect(ServerToAgentMessageSchema.safeParse({ ...create, program: { argv: [] } }).success).toBe(
      false,
    );
  });
});

describe("terminal cwd and restart compatibility", () => {
  test("pre-restart transports stay admitted while restart needs the capable owner", () => {
    expect(TERMINAL_RESTART_PROTOCOL_VERSION).toBe(33);
    for (const version of [30, 31, 32, TERMINAL_RESTART_PROTOCOL_VERSION, PROTOCOL_VERSION]) {
      expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(version)).toBe(true);
    }
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(PROTOCOL_VERSION + 1)).toBe(false);
    expect(TERMINAL_HOST_PROTOCOL_VERSION).toBe(3);
    const status = TerminalHostStatusSchema.parse({
      type: "status",
      terminalHostId: "older-retained-owner",
      terminalHostProtocolVersion: 2,
      build: "old",
      pid: 42,
      draining: false,
      transportAttached: true,
      terminalExecution: "unconfined",
      terminals: [{ terminalId: "t1", cols: 80, rows: 24, alive: true, seq: 1 }],
    });
    expect(status.terminalRestart).toBeUndefined();
    expect(status.terminals[0]?.cwd).toBeUndefined();
  });

  test("readiness is additive on the owner wire and explicit on the session wire", () => {
    const advertised = {
      terminalId: "t1",
      cols: 80,
      rows: 24,
      alive: true,
      seq: 1,
      readiness: "application" as const,
    };
    expect(AdvertisedTerminalSchema.parse(advertised)).toEqual(advertised);
    const observation = {
      type: "terminal_ready" as const,
      terminalId: "t1",
      readiness: "bracketed_paste" as const,
    };
    expect(AgentMessageSchema.parse(observation)).toEqual(observation);
    const event = {
      type: "terminal_event" as const,
      terminalId: "t1",
      kind: "ready" as const,
      readiness: "application" as const,
    };
    expect(ServerMessageBodySchema.parse(event)).toEqual(event);
  });

  test("cwd observations and restart results survive both wires without inventing a home", () => {
    const advertised = { terminalId: "t1", cols: 80, rows: 24, alive: true, seq: 1 };
    expect(AdvertisedTerminalSchema.parse(advertised)).toEqual(advertised);
    expect(AdvertisedTerminalSchema.parse({ ...advertised, cwd: "/work/project" }).cwd).toBe(
      "/work/project",
    );
    const observation = { type: "terminal_cwd" as const, terminalId: "t1", cwd: "/work/project" };
    expect(AgentMessageSchema.parse(observation)).toEqual(observation);
    const restarted = {
      type: "terminal_event" as const,
      terminalId: "t1",
      kind: "restarted" as const,
      cwd: "/home/shell",
      fallback: "home" as const,
      controllerId: "p1",
    };
    expect(ServerMessageBodySchema.parse(restarted)).toEqual(restarted);
    expect(
      AgentMessageSchema.safeParse({ ...observation, cwd: "relative/not-observed" }).success,
    ).toBe(false);
  });

  test("restart can name a retained owner record or carry a replacement owner's program", () => {
    const restart = { type: "terminal_restart" as const, terminalId: "t1" };
    expect(ServerToAgentMessageSchema.parse(restart)).toEqual(restart);
    const replacement = {
      ...restart,
      cwd: "/work/project",
      create: {
        cols: 80,
        rows: 24,
        cwd: "/original",
        env: { PROJECT: "one" },
        program: { argv: ["/bin/sh", "-l"] as TerminalProgram["argv"] },
      },
    };
    expect(ServerToAgentMessageSchema.parse(replacement)).toEqual(replacement);
    expect(
      ServerToAgentMessageSchema.safeParse({
        ...replacement,
        create: { ...replacement.create, program: { argv: [] } },
      }).success,
    ).toBe(false);
  });
});
