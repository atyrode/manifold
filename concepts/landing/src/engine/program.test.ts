import { expect, test } from "bun:test";
import { landDoc, topDoc } from "./docs.ts";
import { engineFeatures, engineProgramKey } from "./program.ts";
import type { EngineDoc, Placed } from "./types.ts";

const block = (id: string, x: number, options: Record<string, number> = {}): Placed => ({
  id,
  kind: "block",
  at: [x, 0, 5],
  yaw: 0,
  scale: 1,
  options,
});

const withObjects = (doc: EngineDoc, ...objects: Placed[]): EngineDoc => ({
  ...doc,
  objects: [...doc.objects, ...objects],
});

test("the kinds a document holds are its program's", () => {
  expect(engineFeatures(landDoc)).toEqual({ ENGINE_GROUND: 1 });
  expect(engineProgramKey(withObjects(landDoc, block("a", 0)))).not.toBe(engineProgramKey(landDoc));
});

test("a kind's instance count keys its program by bucket, not by count", () => {
  const blocks = (n: number) =>
    withObjects(landDoc, ...Array.from({ length: n }, (_, i) => block(`b${i}`, i)));
  expect(engineFeatures(blocks(3))["ENGINE_BLOCK"]).toBe(4);
  expect(engineProgramKey(blocks(3))).toBe(engineProgramKey(blocks(4)));
  expect(engineProgramKey(blocks(4))).not.toBe(engineProgramKey(blocks(5)));
  expect(engineProgramKey(blocks(1))).not.toBe(engineProgramKey(blocks(2)));
  expect(engineFeatures(blocks(32))["ENGINE_BLOCK"]).toBe(32);
  expect(() => engineFeatures(blocks(33))).toThrow(RangeError);
});

test("a compiled option keys the program by the values its instances hold", () => {
  const sphere = (id: string, material: number): Placed => ({
    id,
    kind: "sphere",
    at: [0, 0, 4],
    yaw: 0,
    scale: 1,
    options: { material },
  });
  const matte = withObjects(landDoc, sphere("s", 0));
  const mirror = withObjects(landDoc, sphere("s", 2));
  expect(engineFeatures(matte)["ENGINE_SPHERE_MATERIAL"]).toBe(1);
  expect(engineFeatures(mirror)["ENGINE_SPHERE_MATERIAL"]).toBe(4);
  expect(engineProgramKey(matte)).not.toBe(engineProgramKey(mirror));
  // Two instances, two materials: one program draws both.
  expect(
    engineFeatures(withObjects(landDoc, sphere("a", 0), sphere("b", 2)))["ENGINE_SPHERE_MATERIAL"],
  ).toBe(5);
});

test("moving, turning, scaling or tuning an object leaves the key as it was", () => {
  const key = engineProgramKey(topDoc);
  const tuned: EngineDoc = {
    ...topDoc,
    camera: { ...topDoc.camera, at: [3, 9, -2], pitch: -0.4 },
    world: { time: 0.3, rain: 1 },
    objects: topDoc.objects.map((placed) =>
      placed.kind === "sphere"
        ? {
            ...placed,
            at: [placed.at[0] + 2, placed.at[1], placed.at[2] - 1],
            yaw: 1.2,
            scale: 1.7,
            options: { ...placed.options, radius: 2.5, hue: 0.9, tone: 0.2 },
          }
        : { ...placed, options: { ...placed.options, relief: 30, material: 3 } },
    ),
  };
  expect(engineProgramKey(tuned)).toBe(key);
  // A block's material is a value read per instance, not code.
  expect(engineProgramKey(withObjects(landDoc, block("a", 0, { material: 0 })))).toBe(
    engineProgramKey(withObjects(landDoc, block("a", 0, { material: 3 }))),
  );
});
