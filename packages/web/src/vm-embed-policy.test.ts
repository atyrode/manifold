import { describe, expect, test } from "bun:test";
import { isVmEmbedLink } from "./vm-embed-policy.ts";

describe("VM embed policy", () => {
  test("recognizes only the protected HTTPS VM origin", () => {
    expect(isVmEmbedLink("https://vm.manifold.tyrode.dev/")).toBe(true);
    expect(isVmEmbedLink("http://vm.manifold.tyrode.dev/")).toBe(false);
    expect(isVmEmbedLink("https://vm.manifold.tyrode.dev.attacker.example/")).toBe(false);
    expect(isVmEmbedLink("https://example.com/")).toBe(false);
  });
});
