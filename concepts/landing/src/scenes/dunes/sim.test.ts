import { expect, test } from "bun:test";
import type { SimFrame } from "../types.ts";
import { DUNES_CAMERA, DUNES_MARK, DUNES_SAND, DUNES_SLAB, dunesPointerCell } from "./sim.ts";

const ASPECT = 16 / 9;
const FOCAL = 0.5 / Math.tan(DUNES_CAMERA.fov * 0.5);
const AHEAD = { x: -Math.sin(DUNES_CAMERA.turn), z: Math.cos(DUNES_CAMERA.turn) };
const RIGHT = { x: Math.cos(DUNES_CAMERA.turn), z: Math.sin(DUNES_CAMERA.turn) };

function frameAt(x: number, y: number, parallax = 0): SimFrame {
  return {
    dt: 1 / 60,
    time: 0,
    motionTime: 0,
    motion: 1,
    now: 0,
    budget: Infinity,
    width: 960,
    height: 540,
    aspect: ASPECT,
    values: [],
    params: {},
    triggers: [],
    fired: [],
    pointer: { x, y, inside: true, down: true, pressed: true, released: false },
    parallax: { x: parallax, y: 0 },
    passage: { enter: 1, exit: 0 },
  };
}

/** How far ahead of the aerial camera a grid point lies. */
function aheadOf(p: { x: number; y: number }): number {
  return (p.x - DUNES_CAMERA.x) * AHEAD.x + (p.y - DUNES_CAMERA.z) * AHEAD.z;
}

test("an aerial click lands on the face of the dune drawn under it, not on the mean level behind it", () => {
  // Sand rising in a bank 20 cells high from 60 cells ahead of the camera on. A ray a little below
  // the horizon reaches the mean level some 340 cells out, far behind the bank's face.
  const bank = (x: number, z: number): number =>
    (x - DUNES_CAMERA.x) * AHEAD.x + (z - DUNES_CAMERA.z) * AHEAD.z >= 60 ? 20 : 0;
  const out = { x: 0, y: 0 };
  expect(dunesPointerCell(frameAt(0.5, DUNES_CAMERA.horizon - 0.05), 0, 0, 0, bank, out)).toBe(
    true,
  );
  expect(Math.abs(aheadOf(out) - 60)).toBeLessThan(1);
  // The sky above the horizon has no sand to pour on.
  expect(dunesPointerCell(frameAt(0.5, DUNES_CAMERA.horizon + 0.05), 0, 0, 0, bank, out)).toBe(
    false,
  );
});

test("an aerial click follows the picture's turn toward the pointer (the shader's parallax)", () => {
  const level = (): number => 0;
  const still = { x: 0, y: 0 };
  const turned = { x: 0, y: 0 };
  expect(dunesPointerCell(frameAt(0.5, 0.4, 0), 0, 0.45, 0, level, still)).toBe(true);
  expect(dunesPointerCell(frameAt(0.5, 0.4, 1), 0, 0.45, 0, level, turned)).toBe(true);
  // On level sand the click swings about the eye by the view's parallax turn, toward the pointer's side.
  const a = Math.atan2(still.y - DUNES_CAMERA.z, still.x - DUNES_CAMERA.x);
  const b = Math.atan2(turned.y - DUNES_CAMERA.z, turned.x - DUNES_CAMERA.x);
  expect(Math.abs(a - b)).toBeCloseTo(DUNES_CAMERA.parallax, 6);
  expect((turned.x - still.x) * RIGHT.x + (turned.y - still.y) * RIGHT.z).toBeGreaterThan(0);
});

test("a click on the sandstone M lands at the M, not on the sand far behind it", () => {
  const size = 0.5;
  const height = DUNES_MARK.small + (DUNES_MARK.large - DUNES_MARK.small) * size;
  // Aim at the middle of its left leg (mark units x = -0.47, half way up).
  const across = { x: Math.cos(DUNES_MARK.yaw), z: Math.sin(DUNES_MARK.yaw) };
  const leg = {
    x: DUNES_MARK.x - 0.47 * height * across.x,
    z: DUNES_MARK.z - 0.47 * height * across.z,
  };
  const eye = DUNES_CAMERA.height + DUNES_CAMERA.rise * DUNES_SAND.sparse * DUNES_SLAB;
  const dx = leg.x - DUNES_CAMERA.x;
  const dz = leg.z - DUNES_CAMERA.z;
  const ahead = dx * AHEAD.x + dz * AHEAD.z;
  const right = dx * RIGHT.x + dz * RIGHT.z;
  const x = 0.5 + ((right / ahead) * FOCAL) / ASPECT;
  const y = DUNES_CAMERA.horizon + ((0.5 * height - eye) / ahead) * FOCAL;
  const out = { x: 0, y: 0 };
  expect(dunesPointerCell(frameAt(x, y), 0, 0, size, () => 0, out)).toBe(true);
  expect(Math.hypot(out.x - leg.x, out.y - leg.z)).toBeLessThan(0.2 * height);
  // With the M off the same ray runs on to the sand behind it.
  expect(dunesPointerCell(frameAt(x, y), 0, 0, 0, () => 0, out)).toBe(true);
  expect(Math.hypot(out.x - leg.x, out.y - leg.z)).toBeGreaterThan(height);
});
