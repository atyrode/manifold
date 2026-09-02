import { describe, expect, test } from "bun:test";
import { MAX_BINDING_OVERRIDES, type BindingOverrides } from "@manifold/protocol";
import { keysHandlers } from "../src/server.ts";

/**
 * THE REBIND DOORS, and the honest boundary of what a server can refuse.
 *
 * A key table is browser-side registration data, so these doors have never seen the declared
 * keys — which makes the collision they CAN prove the one worth pinning: two of the caller's own
 * overrides claiming one key. The refusal is the engine's wording (`bindingRebindRefusal`), the
 * same sentence the editor raises with the whole effective table in hand, and it must name BOTH
 * offenders rather than pick a winner.
 *
 * The rest is postconditions: nothing writes when a door refuses, a reset is idempotent because
 * its postcondition ("this row answers its declared key") can already hold, and the per-principal
 * map has a ceiling because it is a write door.
 */

/**
 * The refusal a door answered with, or null for the empty success result. Narrowed with `in`
 * rather than asserted: the handlers publish a union, and a cast would prove nothing about the
 * shape it claims.
 */
function refusalOf(outcome: Awaited<ReturnType<typeof keysHandlers.setBinding>>): string | null {
  return "refused" in outcome ? outcome.refused : null;
}

function store(initial: BindingOverrides = {}): {
  readonly ctx: Parameters<typeof keysHandlers.setBinding>[0];
  readonly writes: BindingOverrides[];
  read(): BindingOverrides;
} {
  let current: BindingOverrides = { ...initial };
  const writes: BindingOverrides[] = [];
  return {
    ctx: {
      principal: { id: "p-1" },
      store: {
        bindingOverrides: (principalId: string): BindingOverrides => {
          expect(principalId).toBe("p-1");
          return current;
        },
        setBindingOverrides: (principalId: string, overrides: BindingOverrides): void => {
          expect(principalId).toBe("p-1");
          current = overrides;
          writes.push(overrides);
        },
      },
    },
    writes,
    read: () => current,
  };
}

describe("core.keys.setBinding", () => {
  test("stores one principal's rebinding as a delta beside the ones already there", async () => {
    const state = store({ "core.shell.arrange": "F4" });
    expect(
      await keysHandlers.setBinding(state.ctx, { binding: "core.debug.inspect", key: "F6" }),
    ).toEqual({});
    expect(state.read()).toEqual({ "core.shell.arrange": "F4", "core.debug.inspect": "F6" });
  });

  test("refuses a key another override already answers, naming both offenders, and writes nothing", async () => {
    const state = store({ "core.debug.inspect": "F6" });
    const outcome = await keysHandlers.setBinding(state.ctx, {
      binding: "core.shell.arrange",
      key: "F6",
    });
    const refused = refusalOf(outcome);
    expect(refused).not.toBeNull();
    expect(refused).toContain("F6");
    expect(refused).toContain("core.debug.inspect");
    expect(refused).toContain("core.shell.arrange");
    expect(state.writes).toHaveLength(0);
  });

  test("rebinding a row that already has an override replaces it rather than colliding", async () => {
    const state = store({ "core.shell.arrange": "F6" });
    expect(
      await keysHandlers.setBinding(state.ctx, { binding: "core.shell.arrange", key: "F6" }),
    ).toEqual({});
    expect(state.read()).toEqual({ "core.shell.arrange": "F6" });
  });

  test("refuses a new row once the per-principal ceiling is full, but still lets a held row move", async () => {
    const full: Record<string, string> = {};
    for (let index = 0; index < MAX_BINDING_OVERRIDES; index += 1) {
      full[`core.filler.row${index}`] = `Key${index}`;
    }
    const state = store(full);
    const refused = await keysHandlers.setBinding(state.ctx, {
      binding: "core.shell.arrange",
      key: "F4",
    });
    expect(refusalOf(refused)).toContain(String(MAX_BINDING_OVERRIDES));
    expect(state.writes).toHaveLength(0);
    // A row already in the map is not a new entry, so moving it stays legal at the ceiling.
    expect(
      await keysHandlers.setBinding(state.ctx, { binding: "core.filler.row0", key: "F4" }),
    ).toEqual({});
    expect(state.read()["core.filler.row0"]).toBe("F4");
  });
});

describe("core.keys.resetBinding", () => {
  test("a named row drops only that row's override", async () => {
    const state = store({ "core.shell.arrange": "F4", "core.debug.inspect": "F6" });
    expect(await keysHandlers.resetBinding(state.ctx, { binding: "core.debug.inspect" })).toEqual(
      {},
    );
    expect(state.read()).toEqual({ "core.shell.arrange": "F4" });
  });

  test("null drops every override — one gesture, one trace", async () => {
    const state = store({ "core.shell.arrange": "F4", "core.debug.inspect": "F6" });
    expect(await keysHandlers.resetBinding(state.ctx, { binding: null })).toEqual({});
    expect(state.read()).toEqual({});
  });

  test("resetting a row that was never rebound succeeds without writing", async () => {
    const state = store({ "core.shell.arrange": "F4" });
    expect(await keysHandlers.resetBinding(state.ctx, { binding: "core.debug.inspect" })).toEqual(
      {},
    );
    expect(state.writes).toHaveLength(0);
    expect(state.read()).toEqual({ "core.shell.arrange": "F4" });
  });
});
