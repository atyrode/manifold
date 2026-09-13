import { describe, expect, test } from "bun:test";
import { ActionRunnerRequestSchema } from "../src/action-runner.ts";
import { decodeAgentJustification, encodeAgentJustification } from "../src/http.ts";

describe("agent justification HTTP encoding", () => {
  test("ASCII wire values preserve Unicode and line breaks until semantic normalization", () => {
    const claim = "Repair the approved target —\nthen verify 日本語 and 100% completion.";
    const encoded = encodeAgentJustification(claim);
    expect(/^[\x21-\x7e]*$/.test(encoded)).toBe(true);
    expect(
      new Headers({ "x-manifold-agent-justification": encoded }).get(
        "x-manifold-agent-justification",
      ),
    ).toBe(encoded);
    expect(decodeAgentJustification(encoded)).toBe(claim);
  });

  test("a malformed version, escape or UTF-8 sequence never becomes an absent claim", () => {
    for (const wire of [
      "",
      "plain claim",
      "v2.claim",
      "v1.%",
      "v1.%GG",
      "v1.%C3%28",
      "v1.%ED%A0%80",
      "v1.raw\nnewline",
      "v1.—",
    ]) {
      expect(() => decodeAgentJustification(wire)).toThrow(TypeError);
    }
    expect(decodeAgentJustification("v1.")).toBe("");
  });

  test("unpaired UTF-16 surrogates are rejected before HTTP transport", () => {
    expect(() => encodeAgentJustification("\ud800")).toThrow(TypeError);
    const frame = {
      type: "invoke",
      id: "unicode",
      runId: "run",
      door: "sample.read",
      target: "manifold://",
      args: {},
      justification: "Verify the approved target.",
    };
    expect(ActionRunnerRequestSchema.safeParse(frame).success).toBe(true);
    expect(ActionRunnerRequestSchema.safeParse({ ...frame, justification: "\udfff" }).success).toBe(
      false,
    );
  });
});
