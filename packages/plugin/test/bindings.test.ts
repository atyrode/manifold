import { describe, expect, test } from "bun:test";
import {
  AssemblyError,
  bindingRebindRefusal,
  composeBindings,
  type BindingSource,
  type WebBinding,
} from "../src/index.ts";

/** A row with a handler that records it ran, so dispatch can be observed without a browser. */
function row(fields: {
  id: string;
  key: string;
  label?: string;
  when?: WebBinding["when"];
  onRun?: () => void;
}): WebBinding {
  return {
    id: fields.id,
    key: fields.key,
    label: fields.label ?? fields.id,
    ...(fields.when === undefined ? {} : { when: fields.when }),
    run: fields.onRun ?? ((): void => {}),
  };
}

/** One plugin's rows, enabled unless a case is about being off. */
function source(plugin: string, bindings: readonly WebBinding[], enabled = true): BindingSource {
  return { plugin, enabled, bindings };
}

describe("binding composition", () => {
  test("publishes each row with its owner and the resolved scope, sorted by key", () => {
    const table = composeBindings([
      source("core.shell", [
        row({ id: "core.shell.zone-probe", key: "F9", label: "Drop-zone probe" }),
        row({ id: "core.shell.arrange", key: "F8", label: "Arrange mode" }),
      ]),
      source("core.canvas", [
        row({ id: "core.canvas.grid", key: "F7", label: "Grid", when: "canvas" }),
      ]),
    ]);

    expect(table.map((binding) => binding.key)).toEqual(["F7", "F8", "F9"]);
    expect(table.map((binding) => binding.plugin)).toEqual([
      "core.canvas",
      "core.shell",
      "core.shell",
    ]);
    // The default is applied at composition, so no reader has to know what an absent scope means.
    expect(table.map((binding) => binding.when)).toEqual(["canvas", "always", "always"]);
  });

  test("dispatch runs the declaring plugin's own handler", () => {
    const ran: string[] = [];
    const table = composeBindings([
      source("core.shell", [
        row({ id: "core.shell.arrange", key: "F8", onRun: () => ran.push("arrange") }),
      ]),
    ]);

    const host = {} as Parameters<(typeof table)[number]["run"]>[0];
    table[0]?.run(host);
    expect(ran).toEqual(["arrange"]);
  });

  test("two plugins claiming one key refuse composition, naming both", () => {
    let error: unknown;
    try {
      composeBindings([
        source("core.shell", [row({ id: "core.shell.arrange", key: "F8" })]),
        source("core.canvas", [row({ id: "core.canvas.align", key: "F8" })]),
      ]);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(AssemblyError);
    const problems = (error as AssemblyError).problems;
    expect(problems).toEqual([`duplicate binding key "F8" claimed by: core.shell, core.canvas`]);
  });

  test("two plugins claiming one binding id refuse composition, naming both", () => {
    expect(() =>
      composeBindings([
        source("core.shell", [row({ id: "core.shell.arrange", key: "F8" })]),
        source("core.shell", [row({ id: "core.shell.arrange", key: "F7" })]),
      ]),
    ).toThrow(/duplicate binding "core\.shell\.arrange" claimed by: core\.shell, core\.shell/);
  });

  test("a row not namespaced by its own plugin refuses, naming the squatter and the id", () => {
    expect(() =>
      composeBindings([source("core.canvas", [row({ id: "core.shell.arrange", key: "F8" })])]),
    ).toThrow(/binding "core\.shell\.arrange" is declared by plugin "core\.canvas"/);
  });

  test("a disabled plugin's rows drop out of the table but still claim their key", () => {
    const table = composeBindings([
      source("core.shell", [row({ id: "core.shell.arrange", key: "F8" })]),
      source("core.canvas", [row({ id: "core.canvas.grid", key: "F7" })], false),
    ]);

    expect(table.map((binding) => binding.id)).toEqual(["core.shell.arrange"]);

    // The claim outlives the drop: a key an enabled plugin could take back on the next toggle
    // is not free, so the collision is reported rather than resolved by whoever is on right now.
    expect(() =>
      composeBindings([
        source("core.shell", [row({ id: "core.shell.arrange", key: "F7" })]),
        source("core.canvas", [row({ id: "core.canvas.grid", key: "F7" })], false),
      ]),
    ).toThrow(/duplicate binding key "F7" claimed by: core\.shell, core\.canvas/);
  });

  test("every problem is reported at once, never the first one found", () => {
    let error: unknown;
    try {
      composeBindings([
        source("core.shell", [row({ id: "shell.arrange", key: "F8" })]),
        source("core.canvas", [row({ id: "core.canvas.align", key: "F8" })]),
      ]);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as AssemblyError).problems).toHaveLength(2);
  });

  test("a composition with no declared key composes an empty table", () => {
    expect(composeBindings([source("core.shell", [])])).toEqual([]);
    expect(composeBindings([])).toEqual([]);
  });
});

/**
 * EFFECTIVE KEYS: one principal's rebindings, applied at the one seam.
 *
 * The contracts are the ones a stale delta walks into. An override is stored per principal while
 * the declarations move underneath it, so what has to hold is that a delta never takes the
 * workspace down (a contested key is DROPPED, declaration wins), that the row still carries what
 * its plugin declared (so a reset is offerable), and that the table stays one table — the
 * dispatcher and the help modal both read `key`.
 */
describe("binding overrides", () => {
  const table = (overrides: Record<string, string>) =>
    composeBindings(
      [
        source("core.shell", [row({ id: "core.shell.arrange", key: "F8", label: "Arrange mode" })]),
        source("core.debug", [row({ id: "core.debug.inspect", key: "F10", label: "Inspector" })]),
      ],
      overrides,
    );

  test("an override replaces the effective key and keeps the declared one beside it", () => {
    const composed = table({ "core.debug.inspect": "F6" });
    const inspector = composed.find((binding) => binding.id === "core.debug.inspect");
    expect(inspector?.key).toBe("F6");
    expect(inspector?.declaredKey).toBe("F10");
    // The row that was not rebound is untouched, declared key and effective key alike.
    const arrange = composed.find((binding) => binding.id === "core.shell.arrange");
    expect(arrange?.key).toBe("F8");
    expect(arrange?.declaredKey).toBe("F8");
  });

  test("an override onto another row's declared key is dropped, not thrown", () => {
    // The case a plugin update produces: the reader bound the inspector to F8 while nothing
    // held it, and `core.shell` now declares F8. Composition must still answer.
    const composed = table({ "core.debug.inspect": "F8" });
    expect(composed.map((binding) => `${binding.id}:${binding.key}`)).toEqual([
      "core.debug.inspect:F10",
      "core.shell.arrange:F8",
    ]);
  });

  test("two overrides claiming one key leave the earlier row applied and the later dropped", () => {
    // Precedence is the TABLE's own order (sorted by declared key), never the wire's iteration
    // order over an object — which is the whole reason the sort runs before the deltas land.
    const composed = table({ "core.shell.arrange": "F4", "core.debug.inspect": "F4" });
    expect(composed.find((binding) => binding.id === "core.debug.inspect")?.key).toBe("F4");
    expect(composed.find((binding) => binding.id === "core.shell.arrange")?.key).toBe("F8");
  });

  test("an override naming a row nobody declared changes nothing", () => {
    expect(table({ "core.gone.row": "F4" }).map((binding) => binding.key)).toEqual(["F10", "F8"]);
  });

  test("an override to the key a row already answers is not a collision with itself", () => {
    expect(table({ "core.shell.arrange": "F8" }).find((b) => b.id === "core.shell.arrange")?.key).toBe(
      "F8",
    );
  });

  test("a disabled plugin's declared key still refuses a rebind onto it", () => {
    // Composition drops a disabled plugin's ROWS but never its claim, and the same asymmetry has
    // to hold for deltas: re-enabling must not resurrect a collision the editor allowed.
    const composed = composeBindings(
      [
        source("core.shell", [row({ id: "core.shell.arrange", key: "F8" })]),
        source("core.canvas", [row({ id: "core.canvas.grid", key: "F7" })], false),
      ],
      { "core.shell.arrange": "F7" },
    );
    expect(composed.map((binding) => binding.key)).toEqual(["F7"]);
  });

  test("no overrides is the same table, by identity", () => {
    const sources = [source("core.shell", [row({ id: "core.shell.arrange", key: "F8" })])];
    expect(composeBindings(sources, {})).toEqual(composeBindings(sources));
  });
});

/**
 * THE REBIND REFUSAL, which is the collision report one level later: a key is a globally claimed
 * name, so a principal moving one row onto another's key gets the same answer two plugins
 * shipping one key get — a refusal naming BOTH offenders, not a winner.
 */
describe("rebind refusal", () => {
  const rows = [
    { id: "core.shell.arrange", key: "F8", plugin: "core.shell" },
    { id: "core.debug.inspect", key: "F10", plugin: "core.debug" },
  ];

  test("names the key, the holder and the row being rebound", () => {
    const refusal = bindingRebindRefusal(rows, "core.shell.arrange", "F10");
    expect(refusal).toContain("F10");
    expect(refusal).toContain("core.debug.inspect");
    expect(refusal).toContain("core.debug");
    expect(refusal).toContain("core.shell.arrange");
  });

  test("a free key and a row's own key are both permitted", () => {
    expect(bindingRebindRefusal(rows, "core.shell.arrange", "F4")).toBeNull();
    expect(bindingRebindRefusal(rows, "core.shell.arrange", "F8")).toBeNull();
  });

  test("rows with no owner still produce a refusal — the server sees ids, not plugins", () => {
    const refusal = bindingRebindRefusal(
      [{ id: "core.debug.inspect", key: "F6" }],
      "core.shell.arrange",
      "F6",
    );
    expect(refusal).toContain("core.debug.inspect");
    expect(refusal).not.toContain("()");
  });
});
