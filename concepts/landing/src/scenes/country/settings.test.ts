import { expect, test } from "bun:test";
import { readParams, readState, serialise } from "../../state.ts";

test("mixed fields and their landscape survive URL reconstruction across other knob edits", () => {
  const fieldType = 4;
  let query = new URLSearchParams(`scene=country&fieldType=${fieldType}&landscape=137&season=2`);
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
    expect(nextParams.fieldType).toBe(fieldType);
    expect(nextParams.landscape).toBe(137);
    expect(nextParams.season).toBe(2);
    if (key === "pixel") expect(nextState.pixel).toBe(Number(value));
    else expect(nextParams[key]).toBe(Number(value));

    const canonical = serialise(nextState, nextParams);
    expect(canonical.get("fieldType")).toBe(String(fieldType));
    expect(canonical.get("landscape")).toBe("137");
    expect(readParams("country", new URLSearchParams(canonical.toString()))).toEqual(nextParams);
    query = canonical;
  }
});

test("changing field type leaves landscape and season independently selected", () => {
  const initial = new URLSearchParams("scene=country&fieldType=1&landscape=83&season=0");
  const state = readState(initial);
  const query = serialise(state, readParams(state.scene, initial));
  query.set("fieldType", "3");

  const params = readParams("country", new URLSearchParams(query.toString()));
  expect(params.fieldType).toBe(3);
  expect(params.landscape).toBe(83);
  expect(params.season).toBe(0);
});
