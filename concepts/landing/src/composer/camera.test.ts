import { describe, expect, test } from "bun:test";
import { catLayer } from "../scenes/sill/layers.ts";
import { sillVariant } from "../scenes/sill/index.ts";
import { sceneDefs } from "../scenes/index.ts";
import { readSetup, serialise } from "../state.ts";
import {
  atRest,
  CAMERA_KEY,
  clampPose,
  decodeCamera,
  encodeCamera,
  layerPoseRange,
  PAINTED,
  REST_POSE,
  type CameraPose,
} from "./camera.ts";
import { ComposeError, composeScene, POSE_GATE, variantPreset } from "./compose.ts";
import { interior } from "./interior.ts";
import type { LayerDef } from "./types.ts";

// The interior's live camera (ADR 0062 "The camera", D18): one packed key read as `elements=` is,
// held to the intersection of the on layers' ranges, a guest out of range refused with its reason.

const pose = (over: Partial<CameraPose>): CameraPose => ({ ...REST_POSE, ...over });
const link = (scene: string, p: CameraPose, extra = "") =>
  new URLSearchParams(`scene=${scene}${extra}&${CAMERA_KEY}=${encodeCamera(p)}`);

describe("the camera", () => {
  test("a pose round-trips through its URL value on its thousandths; rest is no key", () => {
    const moved = pose({ x: -0.25, y: 0.031, z: 0.4, yaw: 0.12, pitch: -0.05, focal: 1.2 });
    expect(decodeCamera(encodeCamera(moved))).toEqual(moved);
    expect(encodeCamera(REST_POSE)).toBe("");
    expect(decodeCamera("")).toEqual(REST_POSE);
    expect(decodeCamera("not base64!")).toEqual(REST_POSE);
    expect(atRest(decodeCamera(encodeCamera(pose({ x: 0.0004 }))))).toBe(true);
  });

  test("a link without the key stands at rest, and a pose reads back as itself", () => {
    expect(readSetup(new URLSearchParams("scene=room")).camera).toEqual(REST_POSE);
    const left = pose({ x: -0.3, z: 0.2, yaw: 0.1 });
    const read = readSetup(link("room", left));
    expect(read.camera).toEqual(left);
    const query = serialise(read.state, read.params, read.planets, read.elements, read.camera);
    expect(query.get(CAMERA_KEY)).toBe(encodeCamera(left));
    // A scene without a camera (outdoors) stands at rest whatever the link says.
    expect(readSetup(link("meadow", left)).camera).toEqual(REST_POSE);
  });

  test("the pose is held to the on layers' ranges: the room's shell, the sill's painted layers", () => {
    const far = pose({ x: 2, y: -2, z: 3, yaw: 1, pitch: -1, focal: 3 });
    const room = sceneDefs.room.camera;
    if (room === undefined) throw new Error("the room has no camera");
    const roomRange = room.range(readSetup(new URLSearchParams("scene=room")).params);
    expect(readSetup(link("room", far)).camera).toEqual(clampPose(far, roomRange));
    // The sill's cat, props and curtain are painted: their tolerance holds the pose near rest.
    const sill = readSetup(link("sill", far)).camera;
    expect(sill.x).toBeCloseTo(PAINTED.x ?? 0, 9);
    expect(sill.focal).toBeCloseTo(1 + (PAINTED.focal ?? 0), 9);
    expect(sill.pitch).toBeCloseTo(-(PAINTED.pitch ?? 0), 9);
    // With them off, the sill's camera goes as far as its shell and window let it.
    const bare = readSetup(link("sill", far, "&cat=0&props=0&curtain=0")).camera;
    expect(bare).toEqual(clampPose(far, roomRange));
  });

  test("off its rest pose a room builds its posed program; moving it further builds nothing new", () => {
    const def = sceneDefs.room;
    const values = readSetup(new URLSearchParams("scene=room")).params;
    expect(def.featuresFor?.(values)[POSE_GATE]).toBe(0);
    expect(def.featuresFor?.(values, REST_POSE)[POSE_GATE]).toBe(0);
    expect(def.featuresFor?.(values, pose({ x: 0.1 }))[POSE_GATE]).toBe(1);
    expect(def.featuresFor?.(values, pose({ x: -0.2, yaw: 0.1 }))[POSE_GATE]).toBe(1);
    expect(def.featuresAllFor?.(values)[POSE_GATE]).toBe(1);
  });

  test("a guest whose range excludes the pose is refused with its reason, and the camera stays", () => {
    const moved = pose({ x: 0.3 });
    const read = readSetup(link("room", moved, "&cat=1"));
    expect(read.camera).toEqual(moved);
    const placement = sceneDefs.room.layers?.place(read.params, read.camera);
    expect(placement?.layers.map(({ layer }) => layer.id)).not.toContain("cat");
    expect(placement?.refused).toContainEqual({
      layer: "cat",
      reason: "the camera's x at 0.30 m lies past 0.03 m, the most it is drawn at",
    });
    expect(sceneDefs.room.featuresFor?.(read.params, read.camera)["LAYER_CAT"]).toBe(0);
    // Within its tolerance it is drawn, and holds the camera there.
    const near = readSetup(link("room", pose({ x: 0.02 }), "&cat=1"));
    expect(
      sceneDefs.room.layers?.place(near.params, near.camera).layers.map((p) => p.layer.id),
    ).toContain("cat");
    const range = sceneDefs.room.camera?.range(near.params, near.camera);
    expect(range?.x).toEqual(layerPoseRange(catLayer.camera, interior.baseline.rig).x);
    // The lava lamp, drawn from the rig, takes the moved camera as it is.
    const lamp = readSetup(link("room", moved, "&lavaLamp=1"));
    expect(
      sceneDefs.room.layers?.place(lamp.params, lamp.camera).layers.map((p) => p.layer.id),
    ).toContain("lavaLamp");
  });

  test("home layers whose ranges do not meet at the rest pose are a ComposeError", () => {
    // A layer drawn only from 10 to 20 cm right of the rest pose.
    const aside: LayerDef = {
      ...catLayer,
      id: "aside",
      switch: { ...catLayer.switch, key: "aside" },
      camera: { x: [0.1, 0.2] },
    };
    const composer = { ...interior, layers: [...interior.layers, aside] };
    const home = variantPreset(interior.baseline, { ...sillVariant, layers: { add: ["aside"] } });
    expect(() => composeScene(composer, home)).toThrow(ComposeError);
    expect(() => composeScene(composer, home)).toThrow("do not meet at its rest pose in x");
    // As a guest it is offered, refused at rest with its reason, and drawn once the camera is there.
    const guest = composeScene(composer, variantPreset(interior.baseline, sillVariant));
    const values = { ...readSetup(new URLSearchParams("scene=sill")).params, aside: 1 };
    expect(guest.def.layers?.place(values, REST_POSE).refused).toContainEqual({
      layer: "aside",
      reason: "the camera's x at 0.00 m lies past 0.10 m, the most it is drawn at",
    });
    const bare = { ...values, cat: 0, props: 0, curtain: 0 };
    const there = guest.def.layers?.place(bare, pose({ x: 0.15 }));
    expect(there?.layers.map(({ layer }) => layer.id)).toContain("aside");
    expect(guest.def.camera?.range(bare, pose({ x: 0.15 })).x).toEqual([0.1, 0.2]);
  });
});
