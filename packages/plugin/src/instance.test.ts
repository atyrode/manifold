import { describe, expect, test } from "bun:test";
import { chooseInstance } from "./instance.ts";

/**
 * The instance decision, which is the whole of AXIOMS §The portable lens that can be checked
 * without a browser: WHICH instance this lens looks at, and what the device should remember
 * afterwards. Every row here is a claim about a lens that can be pointed somewhere and pointed
 * back — the property that distinguishes a lens from a page that only knows its birthplace.
 */
describe("chooseInstance", () => {
  const served = "https://manifold.example";

  test("defaults to the origin that served the lens, and remembers nothing", () => {
    expect(chooseInstance(served, null, null)).toEqual({ origin: served, memory: null });
  });

  test("points the lens at an asked-for instance and remembers it", () => {
    expect(chooseInstance(served, null, "https://other.example")).toEqual({
      origin: "https://other.example",
      memory: "https://other.example",
    });
  });

  test("normalizes the ask, so two spellings of one instance are one instance", () => {
    expect(chooseInstance(served, null, "HTTPS://Other.Example:443/")).toEqual({
      origin: "https://other.example",
      memory: "https://other.example",
    });
  });

  test("keeps looking where the device was pointed, across loads", () => {
    expect(chooseInstance(served, "https://other.example", null)).toEqual({
      origin: "https://other.example",
      memory: "https://other.example",
    });
  });

  test("an empty ask is the way home, and forgets the choice", () => {
    expect(chooseInstance(served, "https://other.example", "")).toEqual({
      origin: served,
      memory: null,
    });
  });

  test("asking for the served origin forgets the memory rather than restating it", () => {
    expect(chooseInstance(served, "https://other.example", served)).toEqual({
      origin: served,
      memory: null,
    });
  });

  test("a malformed ask falls through to the remembered instance instead of destroying it", () => {
    expect(chooseInstance(served, "https://other.example", "not a url")).toEqual({
      origin: "https://other.example",
      memory: "https://other.example",
    });
  });

  test("a path-mounted ask is refused, exactly as a share origin is", () => {
    expect(chooseInstance(served, null, "https://other.example/manifold")).toEqual({
      origin: served,
      memory: null,
    });
  });

  test("a corrupt memory is dropped: the served origin is the fallback that always exists", () => {
    expect(chooseInstance(served, "javascript:alert(1)", null)).toEqual({
      origin: served,
      memory: null,
    });
  });
});
