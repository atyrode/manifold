import { describe, expect, test } from "bun:test";
import type { PrincipalCredentials } from "@manifold/protocol";

import { partitionCredentials } from "../src/rows.ts";

function row(
  id: string,
  sessions: number,
  kind: PrincipalCredentials["principal"]["kind"] = "human",
): PrincipalCredentials {
  return {
    principal: { id, kind, name: id, color: "#ea580c" },
    createdAt: 0,
    sessions: Array.from({ length: sessions }, (_, index) => ({
      id: `${id}-${String(index)}`,
      createdAt: 0,
      caps: ["*" as const],
    })),
  };
}

describe("partitionCredentials (#145)", () => {
  test("a credential-less principal is history, not status", () => {
    const parts = partitionCredentials([row("dead", 0), row("alive", 2), row("gone", 0)]);
    expect(parts.live.map((entry) => entry.principal.id)).toEqual(["alive"]);
    expect(parts.inactive.map((entry) => entry.principal.id)).toEqual(["dead", "gone"]);
  });

  test("server order survives within each half — this module holds no second opinion", () => {
    const parts = partitionCredentials([row("b", 1), row("z", 0), row("a", 1), row("y", 0)]);
    expect(parts.live.map((entry) => entry.principal.id)).toEqual(["b", "a"]);
    expect(parts.inactive.map((entry) => entry.principal.id)).toEqual(["z", "y"]);
  });

  test("service credentials share live and inactive grouping without becoming Agent sessions", () => {
    const parts = partitionCredentials([
      row("service-live", 1, "service"),
      row("agent-inactive", 0, "agent"),
      row("human-live", 1),
      row("service-inactive", 0, "service"),
      row("agent-live", 1, "agent"),
    ]);
    expect(parts.live.map((entry) => [entry.principal.id, entry.principal.kind])).toEqual([
      ["service-live", "service"],
      ["human-live", "human"],
      ["agent-live", "agent"],
    ]);
    expect(parts.inactive.map((entry) => [entry.principal.id, entry.principal.kind])).toEqual([
      ["agent-inactive", "agent"],
      ["service-inactive", "service"],
    ]);
  });

  test("empty is two empty halves, never a throw", () => {
    const parts = partitionCredentials([]);
    expect(parts.live).toEqual([]);
    expect(parts.inactive).toEqual([]);
  });
});
