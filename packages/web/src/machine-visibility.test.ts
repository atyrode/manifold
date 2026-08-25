import { describe, expect, test } from "bun:test";

import type { MachineSummary } from "@manifold/protocol";
import { IDENTITY_COLORS } from "./identity.tsx";
import { machineColor, sessionMachine } from "./machine-visibility.ts";

function machine(id: string, online: boolean): MachineSummary {
  return { id, name: `name-${id}`, online };
}

describe("machineColor", () => {
  test("is deterministic and stays inside the identity palette", () => {
    const first = machineColor("machine-a");
    expect(machineColor("machine-a")).toBe(first);
    expect([...IDENTITY_COLORS] as string[]).toContain(first);
  });

  test("different ids spread across the palette", () => {
    const colors = new Set(
      Array.from({ length: 32 }, (_, index) => machineColor(`machine-${index}`)),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("sessionMachine", () => {
  test("null before the first machines fetch — never flashes offline", () => {
    expect(sessionMachine(null, "m1")).toBeNull();
  });

  test("resolves name, color, and online state", () => {
    const resolved = sessionMachine([machine("m1", true)], "m1");
    expect(resolved).toEqual({
      id: "m1",
      name: "name-m1",
      color: machineColor("m1"),
      online: true,
    });
  });

  test("a machine absent from a fetched list is offline, not unknown-crash", () => {
    const resolved = sessionMachine([machine("m1", true)], "gone");
    expect(resolved?.online).toBe(false);
    expect(resolved?.name).toBe("unknown machine");
  });

  test("offline machines resolve as offline", () => {
    expect(sessionMachine([machine("m1", false)], "m1")?.online).toBe(false);
  });
});
