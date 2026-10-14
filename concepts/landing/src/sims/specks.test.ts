import { expect, test } from "bun:test";
import { followCell, SpeckMap } from "./specks.ts";

const cell = (map: SpeckMap, cx: number, cy: number): [number, number] => {
  const at = (cy * map.width + cx) * 2;
  return [map.data[at] ?? -1, map.data[at + 1] ?? -1];
};

test("a nearer speck keeps its cell when a farther one is plotted after it", () => {
  // The bees' crowd at a hive: a bee in front of the hive (depth 45) is drawn first, one behind the
  // hive's front (depth 47) later. The shader would hide the cell's one speck behind the hive.
  const map = new SpeckMap();
  map.resize(8, 4);
  map.plot(3, 2, 12, 45);
  map.plot(3, 2, 12, 47);
  map.plot(3, 2, 8, 60);
  expect(cell(map, 3, 2)).toEqual([12, 45]);
});

test("a nearer speck plotted later takes the cell from a farther one", () => {
  const map = new SpeckMap();
  map.resize(8, 4);
  map.plot(5, 1, 9, 120);
  map.plot(5, 1, 1, 30);
  expect(cell(map, 5, 1)).toEqual([1, 30]);
});

test("at equal depth the later plot wins, so a creature's detail goes over its body", () => {
  const map = new SpeckMap();
  map.resize(8, 4);
  map.block(2, 0, 3, 1, 1, 20);
  map.block(4, 0, 1, 1, 3, 20);
  expect([cell(map, 2, 0), cell(map, 3, 0), cell(map, 4, 0)]).toEqual([[1, 20], [1, 20], [3, 20]]);
});

test("clear empties every plotted cell, so a farther speck can take the cell next frame", () => {
  const map = new SpeckMap();
  map.resize(6, 6);
  map.plot(1, 1, 4, 10);
  map.plot(1, 1, 5, 200);
  map.block(4, 4, 2, 2, 7, 33);
  map.clear();
  expect(map.data.every((byte) => byte === 0)).toBe(true);
  map.plot(1, 1, 5, 200);
  expect(cell(map, 1, 1)).toEqual([5, 200]);
});

test("cells off the map are ignored and resize starts empty", () => {
  const map = new SpeckMap();
  map.resize(4, 3);
  map.block(-1, -1, 6, 5, 2, 9);
  expect(map.data.filter((byte, i) => i % 2 === 0 && byte === 2).length).toBe(12);
  map.plot(4, 0, 6, 1);
  map.plot(0, 3, 6, 1);
  map.plot(Number.NaN, 0, 6, 1);
  expect(map.data.some((byte, i) => i % 2 === 0 && byte === 6)).toBe(false);
  map.resize(5, 2);
  expect(map.data.length).toBe(20);
  expect(map.data.every((byte) => byte === 0)).toBe(true);
});

test("followCell holds a hovering speck in its cell until it has clearly left", () => {
  let drawn = followCell(Number.NaN, 10.4);
  expect(drawn).toBe(10);
  for (const v of [11.2, 9.7, 11.3]) {
    drawn = followCell(drawn, v);
    expect(drawn).toBe(10);
  }
  expect(followCell(drawn, 11.4)).toBe(11);
  expect(followCell(drawn, 9.6)).toBe(9);
});
