import { describe, expect, test } from "bun:test";

import { IDENTITY_COLORS, identityColorFor, type MachineSummary } from "@manifold/protocol";
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

  test("agrees with the wire's own derivation, id for id", () => {
    // `MachineSummary.color` is now computed server-side from the protocol's palette and
    // hash, and this module still paints the dots the canvas draws until `core.canvas`
    // takes them. The two must not disagree for a single machine, or the same fleet would
    // be two different colors depending on which half of the app drew it.
    for (let index = 0; index < 64; index++) {
      const id = `machine-${String(index)}`;
      expect(machineColor(id)).toBe(identityColorFor(id));
    }
    expect(machineColor("")).toBe(identityColorFor(""));
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
