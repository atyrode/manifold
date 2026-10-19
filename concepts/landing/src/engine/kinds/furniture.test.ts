// The furniture's casts against their known measures: things stand on their tops, and rays pass
// where they are open (under a table's top, between a sideboard's legs, under a shelf's board).
import { describe, expect, test } from "bun:test";
import type { KindDef, Vec3 } from "../types.ts";
import { optionValues } from "./index.ts";
import { shelfKind, SHELF } from "./shelf/index.ts";
import { SIDEBOARD, sideboardKind } from "./sideboard/index.ts";
import { TABLE, tableKind } from "./table/index.ts";

const cast = (kind: KindDef, ro: Vec3, rd: Vec3) =>
  kind.cast?.(
    optionValues(kind, { id: "a", kind: kind.id, at: [0, 0, 0], yaw: 0, scale: 1, options: {} }),
    ro,
    rd,
    [0, 100],
  );
const DOWN: Vec3 = [0, -1, 0];
const ACROSS: Vec3 = [1, 0, 0];

describe("the furniture's casts", () => {
  test("a table: its top from above, open under it between its legs, a leg at its corner", () => {
    const top = cast(tableKind, [0.3, 2, 0.1], DOWN);
    expect(top?.t).toBeCloseTo(2 - 0.75, 6);
    expect(top?.normal).toEqual([0, 1, 0]);
    expect(cast(tableKind, [-2, 0.3, 0], ACROSS)).toBeUndefined();
    const leg = cast(tableKind, [-2, 0.3, 0.375 - TABLE.inset - TABLE.leg / 2], ACROSS);
    expect(leg?.t).toBeCloseTo(2 - 0.6 + TABLE.inset, 6);
  });

  test("a sideboard: its top from above, open between its legs under its carcass", () => {
    expect(cast(sideboardKind, [0.5, 2, 0], DOWN)?.t).toBeCloseTo(2 - 0.75, 6);
    expect(cast(sideboardKind, [-2, SIDEBOARD.legs / 2, 0], ACROSS)).toBeUndefined();
    const front = cast(sideboardKind, [0, 0.4, 2], [0, 0, -1]);
    expect(front?.t).toBeCloseTo(2 - 0.225 + SIDEBOARD.overhang, 6);
  });

  test("a wall shelf: its board from above, open under it between its brackets, a bracket's web", () => {
    expect(cast(shelfKind, [0, 1, 0], DOWN)?.t).toBeCloseTo(1 - SHELF.drop - SHELF.board, 6);
    expect(cast(shelfKind, [0, SHELF.drop / 2, 2], [0, 0, -1])).toBeUndefined();
    // A bracket's web fills the corner under its arm down a slope from the arm's end to its foot:
    // a ray toward the wall meets it the nearer the wall the lower it runs.
    const x = 0.45 - 0.12;
    const d = 0.11;
    const slope = SHELF.drop / (2 * d - 0.04);
    for (const y of [0.02, 0.08, SHELF.drop - 0.03])
      expect(cast(shelfKind, [x, y, 1], [0, 0, -1])?.t).toBeCloseTo(1 + d - y / slope, 6);
  });
});
