import { describe, expect, test } from "bun:test";
import {
  ClientMessageBodySchema,
  MAX_TERMINAL_ARGV_ITEMS,
  MAX_TERMINAL_ENV_KEYS,
  ServerToAgentMessageSchema,
  TERMINAL_PROGRAM_MIN_PROTOCOL_VERSION,
  MACHINE_PROTOCOL_COMPAT_VERSIONS,
  type TerminalProgram,
} from "@manifold/protocol";

/**
 * The program and env a `terminal_open` may carry (issue #192), and the one shape both wires
 * share for it. The lifecycle a program runs under is the agent's and the broker's to prove;
 * this file proves what the FRAME admits and refuses.
 */
describe("terminal_open program and env", () => {
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
    // The field entered the agent wire at a version the compat set accepts, and the set still
    // reaches below it: the broker's gate is what keeps those older agents from ever seeing it.
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(TERMINAL_PROGRAM_MIN_PROTOCOL_VERSION)).toBe(true);
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(TERMINAL_PROGRAM_MIN_PROTOCOL_VERSION - 1)).toBe(
      true,
    );
  });
});
