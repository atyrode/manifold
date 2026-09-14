import type { ManifoldRef, PluginManifest } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import {
  assembleRoster,
  emissionRefusal,
  emitterMayEmit,
  type Assembly,
  type PluginDef,
} from "../src/index.ts";

const NONE = new Set<string>();

/** A manifest with every contribution list present, so a case only states what it is about. */
function manifest(fields: {
  id: string;
  events?: PluginManifest["contributes"]["events"];
}): PluginManifest {
  return {
    id: fields.id,
    version: "0.1.0",
    title: fields.id,
    description: "",
    capabilities: [],
    contributes: {
      panels: [],
      sections: [],
      elements: [],
      tools: [],
      events: fields.events ?? [],
    },
  };
}

const terminals: PluginDef = {
  manifest: manifest({
    id: "core.terminals",
    events: [
      { id: "terminal_exited", title: "Terminal exited" },
      { id: "terminal_opened", title: "Terminal opened" },
    ],
  }),
  actions: [],
};

const index: PluginDef = {
  manifest: manifest({
    id: "core.index",
    events: [{ id: "container_created", title: "Container created" }],
  }),
  actions: [],
};

const CONTAINER: ManifoldRef = { kind: "container", containerId: "c1" };

const assembly = (): Assembly => assembleRoster([terminals, index], NONE);

describe("the declared-topics index", () => {
  test("every declared kind names its owner, and nothing else appears", () => {
    const events = assembly().events;
    expect([...events.keys()]).toEqual(["core.index", "core.terminals"]);
    expect(events.get("core.terminals")?.get("terminal_exited")).toEqual({
      plugin: "core.terminals",
      title: "Terminal exited",
    });
    expect(events.get("core.terminals")?.get("machine_online")).toBeUndefined();
  });

  test("a disabled plugin keeps its declarations, exactly as its panels and elements do", () => {
    // The registries include disabled contributions on purpose: whether a door may fire while
    // its plugin is off is that door's question (D12), asked one rung earlier in the ladder.
    const disabled = assembleRoster([terminals, index], new Set(["core.terminals"]));
    expect(disabled.enabled("core.terminals")).toBe(false);
    expect(disabled.events.get("core.terminals")?.get("terminal_exited")?.plugin).toBe(
      "core.terminals",
    );
    expect(emitterMayEmit(disabled, "core.terminals", CONTAINER, "terminal_exited")).toBe(true);
  });

  test("two plugins may declare and emit the same local kind", () => {
    const other: PluginDef = {
      manifest: manifest({
        id: "third.party",
        events: [{ id: "terminal_exited", title: "Something else entirely" }],
      }),
      actions: [],
    };
    const live = assembleRoster([terminals, other], NONE);
    expect(live.events.get("core.terminals")?.get("terminal_exited")?.title).toBe(
      "Terminal exited",
    );
    expect(live.events.get("third.party")?.get("terminal_exited")?.title).toBe(
      "Something else entirely",
    );
    expect(emitterMayEmit(live, "core.terminals", CONTAINER, "terminal_exited")).toBe(true);
    expect(emitterMayEmit(live, "third.party", CONTAINER, "terminal_exited")).toBe(true);
  });
});

describe("emission is refused unless it was declared", () => {
  test("a declared kind emitted by its owner is legal on any node", () => {
    const live = assembly();
    for (const ref of [
      CONTAINER,
      { kind: "terminal", terminalId: "t1" },
      { kind: "element", containerId: "c1", elementId: "e1" },
      { kind: "principal", principalId: "p1" },
    ] satisfies ManifoldRef[]) {
      expect(emissionRefusal(live, "core.terminals", ref, "terminal_exited")).toBeNull();
    }
  });

  test("an UNDECLARED kind is refused, naming the emitter and the word", () => {
    const refusal = emissionRefusal(assembly(), "core.terminals", CONTAINER, "terminal_vanished");
    expect(refusal).toContain("core.terminals");
    expect(refusal).toContain("terminal_vanished");
    expect(refusal).toContain("contributes.events");
    expect(emitterMayEmit(assembly(), "core.terminals", CONTAINER, "terminal_vanished")).toBe(
      false,
    );
  });

  test("another plugin's declaration does not authorize an undeclared local kind", () => {
    const live = assembly();
    expect(emitterMayEmit(live, "core.terminals", CONTAINER, "terminal_exited")).toBe(true);
    expect(emitterMayEmit(live, "core.index", CONTAINER, "terminal_exited")).toBe(false);
    const refusal = emissionRefusal(live, "core.index", CONTAINER, "terminal_exited");
    expect(refusal).toContain("core.index");
    expect(refusal).toContain("terminal_exited");
  });

  test("a plugin may emit on its OWN node and never on another plugin's", () => {
    /*
      Collection-level facts (a container born, a machine enrolled) have no node of their own,
      so they ride the declaring plugin's node — which makes manifold://plugin/<id> the one
      address form whose topic names a party, and therefore the one that must be checked
      against the emitter. Every other form addresses a node nobody owns exclusively.
    */
    const live = assembly();
    const own: ManifoldRef = { kind: "plugin", pluginId: "core.index" };
    const foreign: ManifoldRef = { kind: "plugin", pluginId: "core.terminals" };
    expect(emissionRefusal(live, "core.index", own, "container_created")).toBeNull();
    const refusal = emissionRefusal(live, "core.index", foreign, "container_created");
    expect(refusal).toContain("another plugin's node");
    expect(refusal).toContain("manifold://plugin/core.terminals");
  });

  test("an assembly that declares nothing refuses every emission", () => {
    // The reserved field with no rows is not an open door: before wave 2 nothing was
    // emittable, and a build whose manifests declare nothing is still in exactly that state.
    const bare = assembleRoster([{ manifest: manifest({ id: "core.bare" }), actions: [] }], NONE);
    expect(emitterMayEmit(bare, "core.bare", CONTAINER, "container_created")).toBe(false);
  });
});
