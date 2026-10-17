import { expect, test } from "bun:test";
import {
  Mobile,
  MOBILE_BALL_CODE,
  MOBILE_MAX_ARMS,
  MOBILE_TEXELS,
  packMobile,
  type MobileArmDesign,
  type MobileDesign,
} from "./mobile.ts";

/** Every arm's tilt from level (degrees) and the largest relative error of any constraint. */
function hang(mobile: Mobile): { tilts: number[]; stretch: number } {
  const sys = mobile.system;
  const pos = sys.positions;
  const tilts: number[] = [];
  for (let k = 0; k < mobile.arms; k++) {
    const [a, b] = mobile.armPoints(k);
    const rise = (pos[b * 3 + 1] ?? 0) - (pos[a * 3 + 1] ?? 0);
    const run = Math.hypot(
      (pos[b * 3] ?? 0) - (pos[a * 3] ?? 0),
      (pos[b * 3 + 2] ?? 0) - (pos[a * 3 + 2] ?? 0),
    );
    tilts.push(Math.abs((Math.atan2(rise, run) * 180) / Math.PI));
  }
  let stretch = 0;
  for (let c = 0; c < sys.constraintCount; c++) {
    const rest = sys.restLength[c] ?? 1;
    stretch = Math.max(
      stretch,
      Math.abs(sys.distance(sys.constraintA[c] ?? 0, sys.constraintB[c] ?? 0) - rest) / rest,
    );
  }
  return { tilts, stretch };
}

test("a pose moves the packed mobile rigidly: a lift raises every point alike, a swing turns it about its anchor", () => {
  const mobile = new Mobile({
    anchor: [0, 3, 0],
    arms: [
      ballArm(-1, 0, 0.3, [0.3, 0.1], 0, 0.04, 0.02),
      ballArm(0, 2, 0.15, [0.45, 0.15], 1, 0.05, 0.03),
      ballArm(1, 2, 0.15, [0.5, 0.15], 2.5, 0.04, 0.02),
    ],
  });
  mobile.settle(240);
  const origin = [0, 1.8, 0] as const;
  const still = new Float32Array(MOBILE_MAX_ARMS * MOBILE_TEXELS * 4);
  const lifted = new Float32Array(still.length);
  const swung = new Float32Array(still.length);
  packMobile(mobile, origin, still);
  packMobile(mobile, origin, lifted, { lift: 0.75, swing: 0 });
  packMobile(mobile, origin, swung, { lift: 0, swing: 0.3 });
  // Arm 0's link top (its texel 3) is the anchor, packed less the origin: a swing leaves it be.
  const anchor = [0, 3 - 1.8, 0];
  for (let c = 0; c < 3; c++) expect(swung[3 * 4 + c]).toBeCloseTo(anchor[c] ?? 0, 5);
  let turned = 0;
  for (let k = 0; k < mobile.arms; k++) {
    for (let i = 0; i < 4; i++) {
      const texel = (k * MOBILE_TEXELS + i) * 4;
      expect(lifted[texel]).toBeCloseTo(still[texel] ?? 0, 6);
      expect(lifted[texel + 1]).toBeCloseTo((still[texel + 1] ?? 0) + 0.75, 5);
      expect(lifted[texel + 2]).toBeCloseTo(still[texel + 2] ?? 0, 6);
      const from = Math.hypot(
        (still[texel] ?? 0) - (anchor[0] ?? 0),
        (still[texel + 1] ?? 0) - (anchor[1] ?? 0),
        (still[texel + 2] ?? 0) - (anchor[2] ?? 0),
      );
      const to = Math.hypot(
        (swung[texel] ?? 0) - (anchor[0] ?? 0),
        (swung[texel + 1] ?? 0) - (anchor[1] ?? 0),
        (swung[texel + 2] ?? 0) - (anchor[2] ?? 0),
      );
      expect(to).toBeCloseTo(from, 4);
      turned = Math.max(turned, Math.abs((swung[texel] ?? 0) - (still[texel] ?? 0)));
    }
    // The balls' codes and radii and the arm's bound do not move.
    for (let i = 4; i < MOBILE_TEXELS; i++) {
      for (let c = 0; c < 4; c++)
        expect(lifted[(k * MOBILE_TEXELS + i) * 4 + c]).toBe(
          still[(k * MOBILE_TEXELS + i) * 4 + c] ?? 0,
        );
    }
  }
  expect(turned).toBeGreaterThan(0.1);
});

/** An arm of two balls, balanced by the lever rule with the wire lumped at its ends as Mobile does. */
function ballArm(
  parent: number,
  end: 0 | 1 | 2,
  link: number,
  reach: [number, number],
  heading: number,
  radius: number,
  mass: number,
): MobileArmDesign {
  const wire = (0.035 * (reach[0] + reach[1])) / 2;
  const weight = ((mass + wire) * reach[0]) / reach[1] - wire;
  return {
    parent,
    end,
    depth: parent + 1,
    link,
    reach,
    loop: 0.03,
    heading,
    balls: [
      { radius, mass, look: 0 },
      { radius: 0.015, mass: weight, look: 1 },
    ],
  };
}

/** Run `substeps` substeps, calling `each` (with the turn so far) before every one, and return how far arm k turned about +y (rad). */
function turning(
  mobile: Mobile,
  k: number,
  substeps: number,
  each?: (s: number, turned: number) => void,
): number {
  const pos = mobile.system.positions;
  const angle = (): number => {
    const [a, b] = mobile.armPoints(k);
    return Math.atan2(
      -((pos[a * 3 + 2] ?? 0) - (pos[b * 3 + 2] ?? 0)),
      (pos[a * 3] ?? 0) - (pos[b * 3] ?? 0),
    );
  };
  let last = angle();
  let total = 0;
  for (let s = 0; s < substeps; s++) {
    each?.(s, total);
    mobile.settle(1);
    const now = angle();
    let d = now - last;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    last = now;
  }
  return total;
}

test("a motor holds its arm's rate, and winds up the turn a knock costs it", () => {
  const mobile = new Mobile({
    anchor: [0, 2, 0],
    arms: [ballArm(-1, 0, 0.3, [0.3, 0.1], 0, 0.04, 0.02)],
  });
  const rate = 0.8;
  mobile.drive(0, rate);
  // Spun up from rest, it first makes up the turn it lost getting going.
  mobile.settle(240 * 30);
  // Then 20 s in still air: the set rate, to half a percent.
  expect(turning(mobile, 0, 240 * 20)).toBeCloseTo(rate * 20, 1);
  // Knocked back against its turn, it falls behind, then catches up the whole turn it lost.
  const pos = mobile.system.positions;
  const [a, , h] = mobile.armPoints(0);
  const out = [
    (pos[a * 3] ?? 0) - (pos[h * 3] ?? 0),
    (pos[a * 3 + 2] ?? 0) - (pos[h * 3 + 2] ?? 0),
  ];
  const l = Math.hypot(out[0] ?? 0, out[1] ?? 0);
  let behind = 0;
  const total = turning(mobile, 0, 240 * 30, (s, turned) => {
    if (s === 0) mobile.kick(0, (-(out[1] ?? 0) / l) * 0.6, 0, ((out[0] ?? 0) / l) * 0.6);
    if (s === 240) behind = turned - rate;
  });
  expect(mobile.balls).toBe(2);
  expect(total).toBeCloseTo(rate * 30, 1);
  expect(behind).toBeLessThan(0);
});

test("arms stacked on one axis hang from the loop above and turn each on its own", () => {
  const mobile = new Mobile({
    anchor: [0, 2.5, 0],
    arms: [
      ballArm(-1, 0, 0.2, [0.3, 0.1], 0, 0.04, 0.02),
      ballArm(0, 2, 0.15, [0.45, 0.15], 1, 0.05, 0.03),
    ],
  });
  expect(mobile.armPoints(1)[3]).toBe(mobile.armPoints(0)[2]);
  mobile.settle(240 * 2);
  const { tilts, stretch } = hang(mobile);
  expect(Math.max(...tilts)).toBeLessThan(3);
  expect(stretch).toBeLessThan(0.01);
  // The lower arm's motor turns it alone: the joint between them passes no turn up.
  mobile.drive(1, 1);
  const pos = mobile.system.positions;
  const [a, b] = mobile.armPoints(0);
  const upper = (): number =>
    Math.atan2(
      -((pos[a * 3 + 2] ?? 0) - (pos[b * 3 + 2] ?? 0)),
      (pos[a * 3] ?? 0) - (pos[b * 3] ?? 0),
    );
  const before = upper();
  expect(turning(mobile, 1, 240 * 10)).toBeGreaterThan(8);
  expect(Math.abs(upper() - before)).toBeLessThan(0.1);
});

test("a ball in the way of another arm's turning wire is pushed aside instead of passed through", () => {
  // The lower arm's wire would sweep through the upper arm's big ball, 6 cm under its hub.
  const mobile = new Mobile({
    anchor: [0, 2.5, 0],
    arms: [
      ballArm(-1, 0, 0.2, [0.3, 0.1], 0, 0.06, 0.03),
      ballArm(0, 2, 0.04, [0.45, 0.15], 2, 0.03, 0.02),
    ],
  });
  mobile.drive(1, 1.2);
  const pos = mobile.system.positions;
  const ball = mobile.ball(0);
  const [a, b, h] = mobile.armPoints(1);
  let closest = Infinity;
  turning(mobile, 1, 240 * 8, () => {
    for (const [p, q] of [
      [a, h],
      [h, b],
    ] as const) {
      const d = [0, 1, 2].map((c) => (pos[q * 3 + c] ?? 0) - (pos[p * 3 + c] ?? 0));
      const w = [0, 1, 2].map((c) => (pos[ball.point * 3 + c] ?? 0) - (pos[p * 3 + c] ?? 0));
      const dd = (d[0] ?? 0) ** 2 + (d[1] ?? 0) ** 2 + (d[2] ?? 0) ** 2;
      const t = Math.min(
        1,
        Math.max(
          0,
          ((w[0] ?? 0) * (d[0] ?? 0) + (w[1] ?? 0) * (d[1] ?? 0) + (w[2] ?? 0) * (d[2] ?? 0)) / dd,
        ),
      );
      closest = Math.min(
        closest,
        Math.hypot(
          (w[0] ?? 0) - (d[0] ?? 0) * t,
          (w[1] ?? 0) - (d[1] ?? 0) * t,
          (w[2] ?? 0) - (d[2] ?? 0) * t,
        ),
      );
    }
  });
  expect(mobile.contacts).toBeGreaterThan(0);
  expect(closest).toBeGreaterThan(ball.radius - 0.005);
});

test("the air pushes a ball along the air whatever its way, and a ball packs as its look and radius", () => {
  const design: MobileDesign = {
    anchor: [0, 2, 0],
    arms: [ballArm(-1, 0, 0.3, [0.2, 0.1], 0.7, 0.05, 0.02)],
  };
  const blown = new Mobile(design);
  blown.settle(480, (_x, _y, _z, out) => {
    out[0] = 1;
  });
  const loop = blown.armPoints(0)[2];
  // A 5 cm ball in a 1 m/s draft: about 2 mN, leaning the arm half a millimetre downwind.
  expect(blown.system.positions[loop * 3] ?? 0).toBeGreaterThan(0.0003);

  const still = new Mobile(design);
  const out = new Float32Array(MOBILE_MAX_ARMS * MOBILE_TEXELS * 4);
  packMobile(still, [0, 1.8, 0], out);
  expect(out[4 * 4]).toBe(MOBILE_BALL_CODE);
  expect(out[4 * 4 + 1]).toBeCloseTo(0.05, 6);
  expect(out[5 * 4]).toBe(MOBILE_BALL_CODE + 1);
  // The arm's bound holds its far ball.
  expect(out[6 * 4] ?? 0).toBeGreaterThan(0.2 + 0.05);
});

test("eleven arms stacked on one axis hold their links: the solver's passes grow with the arms", () => {
  // Each arm reaching further than the one above and turned from it, on a short link from its loop.
  const mobile = new Mobile({
    anchor: [0, 3, 0],
    arms: Array.from({ length: 11 }, (_, k) =>
      ballArm(
        k - 1,
        k === 0 ? 0 : 2,
        k === 0 ? 0.2 : 0.08,
        [0.15 + 0.06 * k, 0.06],
        2.4 * k,
        0.04,
        0.02,
      ),
    ),
  });
  mobile.settle(240 * 6);
  // The top links carry the ten arms below them: at a flat 24 passes they stretched 2.6%.
  expect(hang(mobile).stretch).toBeLessThan(0.01);
});
