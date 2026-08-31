import { describe, expect, test } from "bun:test";
import type { Container } from "@manifold/protocol";
import {
  chooseInitialContainer,
  forgetContainer,
  containerMemoryKey,
  rememberContainer,
  type ContainerMemoryStorage,
} from "./container-memory.ts";

function storage(initial: Record<string, string> = {}): ContainerMemoryStorage & {
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const CONTAINERS: readonly Container[] = [
  { id: "first", name: "First", createdAt: 1, discipline: "canvas" },
  { id: "latest", name: "Latest", createdAt: 2, discipline: "canvas" },
];

describe("container memory", () => {
  test("chooses a visible remembered container", () => {
    const memory = storage({ [containerMemoryKey("p1")]: "latest" });
    expect(chooseInitialContainer(memory, "p1", CONTAINERS)?.id).toBe("latest");
  });

  test("falls back to the first server-listed container", () => {
    const memory = storage({ [containerMemoryKey("p1")]: "deleted" });
    expect(chooseInitialContainer(memory, "p1", CONTAINERS)?.id).toBe("first");
    expect(chooseInitialContainer(memory, "p1", [])).toBeNull();
  });

  test("forgets only the matching remembered container", () => {
    const memory = storage();
    rememberContainer(memory, "p1", "latest");
    forgetContainer(memory, "p1", "first");
    expect(memory.data.get(containerMemoryKey("p1"))).toBe("latest");
    forgetContainer(memory, "p1", "latest");
    expect(memory.data.has(containerMemoryKey("p1"))).toBe(false);
  });
});
