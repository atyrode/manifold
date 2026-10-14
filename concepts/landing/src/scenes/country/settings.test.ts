import { expect, test } from "bun:test";
import { readParams, readState, serialise } from "../../state.ts";

test("field weights and their landscape survive URL reconstruction across other knob edits", () => {
  const weights = { crops: 30, wildflowers: 0, lavender: 50, sunflowers: 20 };
  let query = new URLSearchParams(
    "scene=country&crops=30&wildflowers=0&lavender=50&sunflowers=20&landscape=137&season=2",
  );
  const edits = [
    ["time", "0.25"],
    ["clouds", "0.8"],
    ["rain", "1"],
    ["rain-amount", "0.65"],
    ["lights", "0"],
    ["pixel", "3"],
  ] as const;

  for (const [key, value] of edits) {
    const state = readState(query);
    query = serialise(state, readParams(state.scene, query));
    query.set(key, value);

    const reconstructed = new URLSearchParams(query.toString());
    const nextState = readState(reconstructed);
    const nextParams = readParams(nextState.scene, reconstructed);
    expect(nextState.scene).toBe("country");
    for (const [key, weight] of Object.entries(weights)) expect(nextParams[key]).toBe(weight);
    expect(nextParams.landscape).toBe(137);
    expect(nextParams.season).toBe(2);
    if (key === "pixel") expect(nextState.pixel).toBe(Number(value));
    else expect(nextParams[key]).toBe(Number(value));

    const canonical = serialise(nextState, nextParams);
    expect(canonical.has("fieldType")).toBe(false);
    expect(canonical.get("landscape")).toBe("137");
    expect(readParams("country", new URLSearchParams(canonical.toString()))).toEqual(nextParams);
    query = canonical;
  }
});

test("editing one field weight preserves the other weights, landscape and season", () => {
  const initial = new URLSearchParams(
    "scene=country&crops=20&wildflowers=40&lavender=60&sunflowers=0&landscape=83&season=0",
  );
  const state = readState(initial);
  const query = serialise(state, readParams(state.scene, initial));
  query.set("sunflowers", "80");

  const params = readParams("country", new URLSearchParams(query.toString()));
  expect([params.crops, params.wildflowers, params.lavender, params.sunflowers]).toEqual([
    20, 40, 60, 80,
  ]);
  expect(params.landscape).toBe(83);
  expect(params.season).toBe(0);
});

test("old saved selector recipes migrate once, while explicit weights take precedence", () => {
  const old = new URLSearchParams("scene=country&fieldType=4&landscape=17");
  const state = readState(old);
  const migrated = readParams("country", old);
  expect([migrated.crops, migrated.wildflowers, migrated.lavender, migrated.sunflowers]).toEqual([
    30, 28, 22, 20,
  ]);
  const canonical = serialise(state, migrated);
  expect(canonical.has("fieldType")).toBe(false);
  expect(readParams("country", canonical)).toEqual(migrated);
  old.set("crops", "0");
  const explicit = readParams("country", old);
  expect([explicit.crops, explicit.wildflowers, explicit.lavender, explicit.sunflowers]).toEqual([
    0, 0, 0, 0,
  ]);
  expect(explicit.landscape).toBe(17);
});
