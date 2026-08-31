import { describe, expect, test } from "bun:test";

import type { MachineSummary } from "@manifold/protocol";
import {
  chooseDefaultMachine,
  machineMemoryKey,
  recallMachine,
  rememberMachine,
  type MachineStorage,
} from "../src/machine-choice.ts";

function fakeStorage(initial: Record<string, string> = {}): MachineStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function machine(id: string, online: boolean): MachineSummary {
  return { id, name: `name-${id}`, online };
}

describe("chooseDefaultMachine", () => {
  test("prefers the remembered machine when it is online", () => {
    const machines = [machine("a", true), machine("b", true)];
    expect(chooseDefaultMachine(machines, "b")?.id).toBe("b");
  });

  test("ignores a remembered machine that is offline", () => {
    const machines = [machine("a", true), machine("b", false)];
    expect(chooseDefaultMachine(machines, "b")?.id).toBe("a");
  });

  test("ignores a remembered machine that no longer exists", () => {
    const machines = [machine("a", true)];
    expect(chooseDefaultMachine(machines, "gone")?.id).toBe("a");
  });

  test("falls back to the sole online machine without memory", () => {
    const machines = [machine("a", false), machine("b", true)];
    expect(chooseDefaultMachine(machines, null)?.id).toBe("b");
  });

  test("returns null when several machines are online and none remembered", () => {
    const machines = [machine("a", true), machine("b", true)];
    expect(chooseDefaultMachine(machines, null)).toBeNull();
  });

  test("returns null when nothing is online", () => {
    expect(chooseDefaultMachine([machine("a", false)], "a")).toBeNull();
    expect(chooseDefaultMachine([], null)).toBeNull();
  });
});

describe("machine memory", () => {
  test("round-trips the picked machine per container", () => {
    const storage = fakeStorage();
    rememberMachine(storage, "container-a", "m1");
    rememberMachine(storage, "container-b", "m2");
    expect(recallMachine(storage, "container-a")).toBe("m1");
    expect(recallMachine(storage, "container-b")).toBe("m2");
  });

  test("absent key recalls as null", () => {
    expect(recallMachine(fakeStorage(), "container")).toBeNull();
  });

  test("empty stored value recalls as null", () => {
    const storage = fakeStorage({ [machineMemoryKey("container")]: "" });
    expect(recallMachine(storage, "container")).toBeNull();
  });

  test("throwing storage degrades to a no-op, never throws", () => {
    const broken: MachineStorage = {
      getItem: () => {
        throw new Error("privacy mode");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(recallMachine(broken, "container")).toBeNull();
    expect(() => {
      rememberMachine(broken, "container", "m1");
    }).not.toThrow();
  });

  test("keys are container-scoped", () => {
    expect(machineMemoryKey("abc")).toBe("manifold:machine:abc");
  });
});
