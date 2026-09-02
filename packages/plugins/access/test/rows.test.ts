import { describe, expect, test } from "bun:test";
import type { PrincipalCredentials } from "@manifold/protocol";

import { partitionCredentials } from "../src/rows.ts";

function row(id: string, sessions: number): PrincipalCredentials {
  return {
    principal: { id, kind: "human", name: id, color: "#ea580c" },
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

  test("empty is two empty halves, never a throw", () => {
    const parts = partitionCredentials([]);
    expect(parts.live).toEqual([]);
    expect(parts.inactive).toEqual([]);
  });
});
