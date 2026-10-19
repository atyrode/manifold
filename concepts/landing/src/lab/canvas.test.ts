import { describe, expect, test } from "bun:test";
import type {
  EngineCamera,
  EngineDoc,
  EngineView,
  KindDef,
  Placed,
  Vec3,
} from "../engine/types.ts";
import { feature, range } from "../params.ts";
import {
  cameraRay,
  lookAt,
  objectToWorld,
  orbit,
  projectBounds,
  projectPoint,
  sub,
} from "./canvas-camera.ts";
import {
  DOCS_VERSION,
  deleteDoc,
  exportDoc,
  importDoc,
  parseDoc,
  readDocs,
  saveDoc,
  writeDocs,
} from "./canvas-docs.ts";
import {
  canvasHistoryAt,
  recordCanvas,
  redoCanvas,
  undoCanvas,
  type CanvasStep,
} from "./canvas-history-model.ts";
import {
  addObject,
  duplicateObject,
  kindRefusal,
  knobValues,
  moveObject,
  objectNames,
  palette,
  removeObject,
  scaleObject,
  SCALE_RANGE,
  turnObject,
} from "./canvas-model.ts";
import { DROP_AHEAD, DROP_REACH, dragPoint, dropPoint, grip } from "./canvas-place.ts";
import { COALESCE_MS } from "./history-model.ts";

// ---- fixtures: kinds, a document, and a fake engine view ---------------------------------------

const code = () => Promise.resolve({ glsl: () => "" });
const kind = (def: Omit<KindDef, "code" | "blurb"> & { blurb?: string }): KindDef => ({
  blurb: "",
  code,
  ...def,
});
const box = (w: number, h: number, d: number) => () => ({
  min: [-w / 2, 0, -d / 2] as Vec3,
  max: [w / 2, h, d / 2] as Vec3,
});

const lawn = kind({
  id: "lawn",
  title: "Lawn",
  family: "ground",
  options: [],
  bounds: () => ({ min: [-50, -0.1, -50], max: [50, 0, 50] }),
  exclusive: "ground",
  max: 1,
  rests: "free",
});
const sand = kind({ ...lawn, id: "sand", title: "Sand" });
const lamp = kind({
  id: "lamp",
  title: "Lamp",
  family: "light",
  options: [
    range("lamp", "glow", "glow", 0.5, "How bright.", { min: 0, max: 1, step: 0.05 }),
    feature("lamp", "flicker", "flicker", false, "amount", 0.3, "A guttering flame."),
  ],
  bounds: box(0.4, 1.6, 0.4),
  max: 3,
  rests: "surface",
});
const table = kind({
  id: "table",
  title: "Table",
  family: "furniture",
  options: [],
  bounds: box(1.2, 0.75, 0.8),
  max: 8,
  rests: "surface",
});
const kite = kind({
  id: "kite",
  title: "Kite",
  family: "prop",
  blurb: "A diamond on a string.",
  options: [],
  bounds: box(0.8, 1, 0.1),
  max: 4,
  rests: "free",
});
const kinds = [lawn, sand, lamp, table, kite];

const camera: EngineCamera = { at: [0, 1.6, -5], yaw: 0, pitch: 0, fov: Math.PI / 3 };
const placed = (id: string, kindId: string, at: Vec3, more: Partial<Placed> = {}): Placed => ({
  id,
  kind: kindId,
  at,
  yaw: 0,
  scale: 1,
  options: {},
  ...more,
});
const doc: EngineDoc = {
  v: 1,
  title: "Garden",
  camera,
  world: { time: 0.5 },
  objects: [
    placed("lawn-1", "lawn", [0, 0, 0]),
    placed("lamp-1", "lamp", [1, 0, 2]),
    placed("table-1", "table", [-1, 0, 3]),
  ],
};

/**
 * A fake engine view over a W×H cell grid: picks by each object's projected bounds (the nearest
 * whose rectangle holds the cell), and finds surfaces on the tops of the objects' bounds (all but
 * one ignored, and the ground's) and the y = 0 plane.
 */
function fakeView(
  start: EngineDoc,
  width = 160,
  height = 90,
): EngineView & { cells: [number, number] } {
  let current = start;
  const ndc = (x: number, y: number) => [(2 * x) / width - 1, (2 * y) / height - 1] as const;
  return {
    cells: [width, height],
    get doc() {
      return current;
    },
    setDoc(next) {
      current = next;
    },
    pick(x, y) {
      const [px, py] = ndc(x, y);
      let best: { id: string; depth: number } | undefined;
      for (const object of current.objects) {
        const def = kinds.find((candidate) => candidate.id === object.kind);
        if (!def || def.family === "ground") continue;
        const bounds = def.bounds(object.options);
        const rect = projectBounds(current.camera, object, bounds, width / height);
        const centre = projectPoint(
          current.camera,
          objectToWorld(object, [0, 0, 0]),
          width / height,
        );
        if (!rect || !centre) continue;
        const inside =
          px >= rect.min[0] && px <= rect.max[0] && py >= rect.min[1] && py <= rect.max[1];
        if (inside && (!best || centre.depth < best.depth))
          best = { id: object.id, depth: centre.depth };
      }
      return best?.id;
    },
    surface(x, y, ignore) {
      const [px, py] = ndc(x, y);
      return castFake(
        current,
        current.camera.at,
        cameraRay(current.camera, px, py, width / height),
        ignore,
      );
    },
    cast(origin, dir, ignore) {
      return castFake(current, origin, dir, ignore);
    },
  };
}

/** The fake view's surfaces along a ray: the y = 0 plane and the tops of the objects' bounds. */
function castFake(current: EngineDoc, eye: Vec3, ray: Vec3, ignore?: string) {
  let best: { t: number; at: Vec3 } | undefined;
  const consider = (top: number, inside: (p: Vec3) => boolean) => {
    if (Math.abs(ray[1]) < 1e-9) return;
    const t = (top - eye[1]) / ray[1];
    const p: Vec3 = [eye[0] + ray[0] * t, top, eye[2] + ray[2] * t];
    if (t > 0 && inside(p) && (!best || t < best.t)) best = { t, at: p };
  };
  consider(0, () => true);
  for (const object of current.objects) {
    const def = kinds.find((candidate) => candidate.id === object.kind);
    if (!def || object.id === ignore || def.family === "ground") continue;
    const { min, max } = def.bounds(object.options);
    consider(object.at[1] + max[1] * object.scale, (p) => {
      const local = sub(p, object.at);
      return (
        local[0] >= min[0] * object.scale &&
        local[0] <= max[0] * object.scale &&
        local[2] >= min[2] * object.scale &&
        local[2] <= max[2] * object.scale
      );
    });
  }
  const found: { t: number; at: Vec3 } | undefined = best;
  return found && { at: found.at, normal: [0, 1, 0] as Vec3 };
}

const near = (a: readonly number[], b: readonly number[], digits = 6) =>
  a.forEach((value, at) => expect(value).toBeCloseTo(b[at] ?? Number.NaN, digits));

// ---- the palette --------------------------------------------------------------------------------

describe("the palette", () => {
  test("refuses a second of an exclusive group, naming what holds it", () => {
    const sandRefusal = kindRefusal(doc, sand, kinds);
    expect(sandRefusal?.kind).toBe("sand");
    expect(sandRefusal?.why).toContain("lawn");
    expect(sandRefusal?.why).toContain("one ground");
    expect(kindRefusal(doc, lawn, kinds)?.why).toContain("its lawn already");
    const bare = { ...doc, objects: doc.objects.filter((object) => object.kind !== "lawn") };
    expect(kindRefusal(bare, sand, kinds)).toBeUndefined();
  });

  test("refuses a kind once the document holds its max", () => {
    let full: EngineDoc = doc;
    for (const at of [3, 4] as const) {
      const added = addObject(full, lamp, kinds, [at, 0, 0], 0);
      if ("why" in added) throw new Error(added.why);
      full = added.doc;
    }
    expect(kindRefusal(full, lamp, kinds)?.why).toBe("At most 3 of lamp in a document.");
    expect(addObject(full, lamp, kinds, [9, 0, 0], 0)).toEqual({
      kind: "lamp",
      why: "At most 3 of lamp in a document.",
    });
    expect(kindRefusal(full, table, kinds)).toBeUndefined();
  });

  test("groups kinds by family in the palette's order, each with its refusal, and searches", () => {
    const rows = palette(doc, kinds, "");
    expect(rows.map((row) => row.family.id)).toEqual(["ground", "furniture", "light", "prop"]);
    expect(rows[0]?.kinds.map(({ kind: k, refusal }) => [k.id, refusal !== undefined])).toEqual([
      ["lawn", true],
      ["sand", true],
    ]);
    expect(
      palette(doc, kinds, "diamond").map((row) => row.kinds.map(({ kind: k }) => k.id)),
    ).toEqual([["kite"]]);
    expect(
      palette(doc, kinds, "furniture").flatMap((row) => row.kinds.map(({ kind: k }) => k.id)),
    ).toEqual(["table"]);
  });
});

// ---- edits --------------------------------------------------------------------------------------

describe("an edit of the document", () => {
  const untouched = (before: EngineDoc, after: EngineDoc, id: string) => {
    for (const object of before.objects)
      if (object.id !== id)
        expect(after.objects.find((other) => other.id === object.id)).toBe(object);
    expect(new Set(after.objects.map((object) => object.id)).size).toBe(after.objects.length);
  };

  test("adds an object with a fresh id, at its natural size and default options", () => {
    const added = addObject(doc, lamp, kinds, [2, 0, 1], 4 * Math.PI);
    if ("why" in added) throw new Error(added.why);
    expect(added.id).toBe("lamp-2");
    expect(added.doc.objects.at(-1)).toEqual(placed("lamp-2", "lamp", [2, 0, 1]));
    untouched(doc, added.doc, added.id);
    expect(doc.objects).toHaveLength(3);
  });

  test("moves, turns and scales one object, leaving the others as they were", () => {
    const moved = moveObject(doc, "lamp-1", [5, 0.75, 5]);
    expect(moved.objects[1]?.at).toEqual([5, 0.75, 5]);
    untouched(doc, moved, "lamp-1");
    const turned = turnObject(doc, "lamp-1", 3 * Math.PI + 0.5);
    expect(turned.objects[1]?.yaw).toBeCloseTo(-Math.PI + 0.5, 9);
    untouched(doc, turned, "lamp-1");
    expect(scaleObject(doc, "table-1", 2).objects[2]?.scale).toBe(2);
    expect(scaleObject(doc, "table-1", 1e6).objects[2]?.scale).toBe(SCALE_RANGE.max);
    expect(scaleObject(doc, "table-1", 0).objects[2]?.scale).toBe(SCALE_RANGE.min);
    untouched(doc, scaleObject(doc, "table-1", 2), "table-1");
    expect(moveObject(doc, "nothing", [0, 0, 0])).toBe(doc);
  });

  test("deletes one object", () => {
    const after = removeObject(doc, "lamp-1");
    expect(after.objects.map((object) => object.id)).toEqual(["lawn-1", "table-1"]);
    untouched(doc, after, "lamp-1");
    expect(removeObject(doc, "nothing")).toBe(doc);
  });

  test("duplicates an object beside it, after it, with a fresh id and its options", () => {
    const tuned = {
      ...doc,
      objects: doc.objects.map((o) => (o.id === "lamp-1" ? { ...o, options: { glow: 0.9 } } : o)),
    };
    const copy = duplicateObject(tuned, "lamp-1", kinds);
    if (!copy || "why" in copy) throw new Error("no copy");
    expect(copy.id).toBe("lamp-2");
    expect(copy.doc.objects.map((object) => object.id)).toEqual([
      "lawn-1",
      "lamp-1",
      "lamp-2",
      "table-1",
    ]);
    const made = copy.doc.objects[2];
    expect(made?.options).toEqual({ glow: 0.9 });
    near(made?.at ?? [], [1 + 0.4 * 1.25, 0, 2]);
    untouched(tuned, copy.doc, "lamp-2");
    expect(duplicateObject(doc, "lawn-1", kinds)).toMatchObject({ kind: "lawn" });
  });

  test("keeps knob values clamped and only where they differ from their defaults", () => {
    expect(knobValues(lamp.options, { glow: 0.8 }, { glow: 7 })).toEqual({ glow: 1 });
    expect(knobValues(lamp.options, { glow: 0.8 }, { glow: 0.5 })).toEqual({});
    expect(knobValues(lamp.options, {}, { flicker: 1, "flicker-amount": 0.6, stray: 3 })).toEqual({
      flicker: 1,
      "flicker-amount": 0.6,
    });
  });

  test("names objects by kind, numbered where a kind stands more than once", () => {
    const two = addObject(doc, lamp, kinds, [0, 0, 0], 0);
    if ("why" in two) throw new Error(two.why);
    const names = objectNames(two.doc, kinds);
    expect(names.get("lamp-1")).toMatchObject({ title: "Lamp", label: "1" });
    expect(names.get("lamp-2")).toMatchObject({ title: "Lamp", label: "2" });
    expect(names.get("table-1")).toMatchObject({ title: "Table", label: "" });
  });
});

// ---- the camera and the selection cue ----------------------------------------------------------

describe("the camera", () => {
  const level: EngineCamera = { at: [0, 0, 0], yaw: 0, pitch: 0, fov: Math.PI / 2 };

  test("projects a point back onto the ray through it", () => {
    const tilted: EngineCamera = { at: [1, 2, 3], yaw: 0.7, pitch: -0.4, fov: 1 };
    const ray = cameraRay(tilted, 0.3, -0.6, 16 / 9);
    const p = projectPoint(tilted, [1 + ray[0] * 7, 2 + ray[1] * 7, 3 + ray[2] * 7], 16 / 9);
    near(
      [p?.x ?? 0, p?.y ?? 0, p?.depth ?? 0],
      [
        0.3,
        -0.6,
        7 *
          (ray[0] * -Math.sin(0.7) * Math.cos(-0.4) +
            ray[1] * Math.sin(-0.4) +
            ray[2] * Math.cos(0.7) * Math.cos(-0.4)),
      ],
    );
    expect(projectPoint(tilted, [1, 2, 3], 1)).toBeUndefined();
  });

  test("turns counter-clockwise seen from above: a quarter turn looks along -x", () => {
    const left = projectPoint({ ...level, yaw: Math.PI / 2 }, [-5, 0, 0], 1);
    near([left?.x ?? 1, left?.y ?? 1, left?.depth ?? 0], [0, 0, 5]);
  });

  test("projects an object's bounds to the rectangle they cover", () => {
    const rect = projectBounds(
      level,
      placed("t", "table", [0, 0, 5]),
      { min: [-1, 0, -0.5], max: [1, 2, 0.5] },
      1,
    );
    near([...(rect?.min ?? []), ...(rect?.max ?? [])], [-1 / 4.5, 0, 1 / 4.5, 2 / 4.5]);
    // Turned a quarter, its depth runs across: x -0.5..0.5, z 4..6.
    const turned = projectBounds(
      level,
      placed("t", "table", [0, 0, 5], { yaw: Math.PI / 2 }),
      { min: [-1, 0, -0.5], max: [1, 2, 0.5] },
      1,
    );
    near([...(turned?.min ?? []), ...(turned?.max ?? [])], [-0.5 / 4, 0, 0.5 / 4, 2 / 4]);
    // Twice the size, from twice as far: the same rectangle.
    const big = projectBounds(
      level,
      placed("t", "table", [0, 0, 10], { scale: 2 }),
      { min: [-1, 0, -0.5], max: [1, 2, 0.5] },
      1,
    );
    near([...(big?.min ?? []), ...(big?.max ?? [])], [-1 / 4.5, 0, 1 / 4.5, 2 / 4.5]);
  });

  test("cuts bounds where they pass behind the eye, and drops bounds wholly behind it", () => {
    const bounds = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };
    expect(projectBounds(level, placed("t", "table", [0, 0, -5]), bounds, 1)).toBeUndefined();
    const around = projectBounds(level, placed("t", "table", [0, 0, 0.5]), bounds, 1);
    expect(around && Number.isFinite(around.max[0]) && around.max[0] > 10).toBe(true);
  });

  test("orbits about a point, which stays where it was on the picture", () => {
    const pivot: Vec3 = [1, 0, 6];
    const before = projectPoint(camera, pivot, 1.5);
    const after = orbit(camera, pivot, 0.8, -0.3);
    const seen = projectPoint(after, pivot, 1.5);
    near(
      [seen?.x ?? 9, seen?.y ?? 9, seen?.depth ?? 0],
      [before?.x ?? 0, before?.y ?? 0, before?.depth ?? 0],
    );
    expect(after.yaw).toBeCloseTo(0.8, 9);
    expect(after.pitch).toBeCloseTo(-0.3, 9);
  });

  test("looks at a point: it comes to the picture's centre", () => {
    const seen = projectPoint(lookAt(camera, [4, -1, 2]), [4, -1, 2], 1);
    near([seen?.x ?? 1, seen?.y ?? 1], [0, 0]);
  });
});

// ---- placing and dragging through a view -------------------------------------------------------

describe("placing through the view", () => {
  test("drops a new object where the centre's ray meets a surface near, else below a point ahead", () => {
    const view = fakeView({ ...doc, camera: { ...camera, pitch: -0.3 } });
    const [w, h] = view.cells;
    const at = dropPoint(view, [w / 2, h / 2]);
    expect(at[1]).toBe(0);
    near([at[0], at[2]], [0, -5 + 1.6 / Math.tan(0.3)]);
    // A level eye meets the ground about 32 m off: the object stands on the ground just ahead.
    const level = fakeView({ ...doc, camera: { ...camera, pitch: -0.05 } });
    near(dropPoint(level, [w / 2, h / 2]), [0, 0, -5 + DROP_AHEAD * Math.cos(0.05)]);
    expect(DROP_REACH).toBeLessThan(1.6 / Math.tan(0.05));
    const skyward = fakeView({ ...doc, camera: { ...camera, pitch: 0.3 } });
    near(dropPoint(skyward, [w / 2, h / 2]), [0, 0, -5 + DROP_AHEAD * Math.cos(0.3)]);
  });

  test("picks by projected bounds, nearest first", () => {
    const view = fakeView({ ...doc, camera: { at: [1, 0.8, -3], yaw: 0, pitch: 0, fov: 1 } });
    const [w, h] = view.cells;
    expect(view.pick(w / 2, h / 2)).toBe("lamp-1");
    expect(view.pick(1, h - 1)).toBeUndefined();
  });

  test("a drag holds the point grabbed: a tall object grabbed at its top follows the pointer", () => {
    const view = fakeView({ ...doc, camera: { at: [0, 2.5, -4], yaw: 0, pitch: -0.3, fov: 1 } });
    const eye = view.doc.camera.at;
    const toward = (p: Vec3): Vec3 => {
      const d = sub(p, eye);
      const n = Math.hypot(...d);
      return [d[0] / n, d[1] / n, d[2] / n];
    };
    const object = view.doc.objects[1];
    if (!object) throw new Error("no lamp");
    // Grabbed on its top (1.6 m up), whose ray goes on to meet the ground far beyond it.
    const held = grip(view, object, toward([1, 1.6, 2]));
    near(held.from, [1, 1.6, 2]);
    near(dragPoint(view, object, lamp, toward([1, 1.6, 2]), held) ?? [], object.at);
    // Half a metre across at the grabbed height: half a metre across on the ground.
    near(dragPoint(view, object, lamp, toward([1.5, 1.6, 2]), held) ?? [], [1.5, 0, 2]);
    // Carried over the table, it rests on the table's top, never on itself.
    near(dragPoint(view, object, lamp, toward([-1, 1.6, 3]), held) ?? [], [-1, 0.75, 3]);
  });

  test("drags a free object across the level plane at its height", () => {
    const view = fakeView({ ...doc, camera: { at: [0, 4, -4], yaw: 0, pitch: -0.3, fov: 1 } });
    const flying = placed("kite-1", "kite", [0, 2.5, 4]);
    const held = { from: flying.at, base: flying.at };
    const ray = cameraRay(view.doc.camera, 0.2, 0.1, 16 / 9);
    const at = dragPoint(view, flying, kite, ray, held);
    expect(at?.[1]).toBeCloseTo(2.5, 9);
    const seen = projectPoint(view.doc.camera, at ?? [0, 0, 0], 16 / 9);
    near([seen?.x ?? 0, seen?.y ?? 0], [0.2, 0.1]);
  });
});

// ---- undo -----------------------------------------------------------------------------------------

describe("the canvas's undo", () => {
  const step = (x: number, query = "scene=canvas"): CanvasStep => ({
    doc: moveObject(doc, "lamp-1", [x, 0, 2]),
    query,
    words: `move to ${x}`,
  });

  test("makes a drag's commits, and a wheel run's, one step", () => {
    const history = canvasHistoryAt({ doc, query: "scene=canvas", words: "" });
    for (let at = 1; at <= 30; at++)
      recordCanvas(history, step(3 + at / 10), 1000 + at * 40, "move lamp-1");
    expect(history.undo).toHaveLength(1);
    expect(undoCanvas(history)?.doc).toBe(doc);
    expect(redoCanvas(history)?.doc.objects[1]?.at).toEqual([6, 0, 2]);
  });

  test("keeps different changes, or the same one after a pause, as steps of their own", () => {
    const history = canvasHistoryAt({ doc, query: "scene=canvas", words: "" });
    recordCanvas(history, step(7), 0, "move lamp-1");
    recordCanvas(
      history,
      { ...step(7), doc: turnObject(step(7).doc, "lamp-1", 1) },
      100,
      "turn lamp-1",
    );
    recordCanvas(history, { ...step(7), query: "scene=canvas&dither=ign" }, 200, "dither");
    recordCanvas(history, step(3), 200 + COALESCE_MS + 1, "move lamp-1");
    expect(history.undo).toHaveLength(4);
    expect(undoCanvas(history)?.query).toBe("scene=canvas&dither=ign");
    expect(undoCanvas(history)?.query).toBe("scene=canvas");
    expect(recordCanvas(history, history.committed, 9999, "move lamp-1")).toBe(false);
  });

  test("drops a step grown back to where it began", () => {
    const history = canvasHistoryAt({ doc, query: "scene=canvas", words: "" });
    recordCanvas(history, step(5), 0, "move lamp-1");
    recordCanvas(history, { doc, query: "scene=canvas", words: "back" }, 50, "move lamp-1");
    expect(history.undo).toHaveLength(0);
    expect(history.committed.doc).toBe(doc);
  });
});

// ---- documents --------------------------------------------------------------------------------

describe("documents kept in the browser", () => {
  test("come back as saved, in order, a save over a name in its place", () => {
    const later = { ...doc, title: "Later" };
    let docs = saveDoc([], "Garden", doc, 1);
    docs = saveDoc(docs, "Night", later, 2);
    docs = saveDoc(docs, "Garden", later, 3);
    expect(readDocs(writeDocs(docs))).toEqual([
      { name: "Garden", savedAt: 3, doc: later },
      { name: "Night", savedAt: 2, doc: later },
    ]);
    expect(deleteDoc(docs, "Garden").map((saved) => saved.name)).toEqual(["Night"]);
  });

  test("keep only well-formed documents, and none from another version or no record", () => {
    const good = { name: "Garden", savedAt: 1, doc };
    const record = (docs: unknown[], v = DOCS_VERSION) => JSON.stringify({ v, docs });
    expect(
      readDocs(
        record([
          good,
          { ...good, name: "" },
          { ...good, name: "Bad", doc: { ...doc, camera: null } },
          { name: "Odd", savedAt: "x", doc },
        ]),
      ),
    ).toEqual([good]);
    expect(readDocs(record([good], 2))).toEqual([]);
    expect(readDocs("{not json")).toEqual([]);
    expect(readDocs(null)).toEqual([]);
    expect(readDocs(JSON.stringify([good]))).toEqual([]);
  });

  test("refuse a malformed document, saying why", () => {
    const why = (value: unknown) => {
      const parsed = parseDoc(value);
      return "why" in parsed ? parsed.why : "";
    };
    expect(why(null)).toBe("It is not a document.");
    expect(why({ ...doc, v: 2 })).toBe("It is a document of version 2, not 1.");
    expect(why({ ...doc, camera: { ...camera, fov: 4 } })).toContain("field of view");
    expect(why({ ...doc, camera: { ...camera, at: [0, 1] } })).toContain("camera's place");
    expect(why({ ...doc, world: { time: "noon" } })).toContain('"time" is not a number');
    expect(
      why({ ...doc, objects: [placed("a", "lamp", [0, 0, 0]), placed("a", "lamp", [1, 0, 0])] }),
    ).toBe('Two of its objects share the id "a".');
    expect(why({ ...doc, objects: [{ ...placed("a", "lamp", [0, 0, 0]), scale: 0 }] })).toContain(
      "scale",
    );
    expect(
      why({ ...doc, objects: [{ ...placed("a", "lamp", [0, 0, 0]), options: { glow: null } }] }),
    ).toContain("option");
  });

  test("refuse a file naming a kind this build lacks, or more of a kind than it allows", () => {
    const why = (value: EngineDoc) => {
      const parsed = importDoc(JSON.stringify(value), kinds);
      return "why" in parsed ? parsed.why : "";
    };
    expect(
      why({ ...doc, objects: [...doc.objects, placed("rocket-1", "rocket", [0, 0, 0])] }),
    ).toBe('This build has no kind "rocket": its object cannot be shown.');
    const lamps = [1, 2, 3, 4].map((n) => placed(`lamp-${n}`, "lamp", [n, 0, 0]));
    expect(why({ ...doc, objects: lamps })).toBe("It holds 4 of lamp, more than 3.");
    expect(
      why({
        ...doc,
        objects: [placed("lawn-1", "lawn", [0, 0, 0]), placed("sand-1", "sand", [0, 0, 0])],
      }),
    ).toBe("It holds 2 of one ground, where one is allowed.");
    expect(importDoc("not json", kinds)).toEqual({ why: "The file is not JSON." });
  });

  test("go to a file and come back from it unchanged", () => {
    const file = exportDoc({ ...doc, title: "My  Garden!" });
    expect(file.name).toBe("my-garden.json");
    expect(importDoc(file.text, kinds)).toEqual({ doc: { ...doc, title: "My  Garden!" } });
  });
});
