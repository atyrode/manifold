import { describe, expect, test } from "bun:test";
import {
  AssemblyError,
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
