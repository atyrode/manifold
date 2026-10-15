// Bodies that touch as discs on a plane and must not pass through one another: a correction run
// after each integration step, for sims whose bodies otherwise push apart with soft contact forces
// (the lantern river's lanterns; walkers, koi or grazing animals could share it). Soft forces keep
// a crowd jostling gently but let a body set down on top of another (or two set down on one spot,
// which a force cannot even tell apart) sink in for a long while; this sets a floor under that.
//
// Each pair nearer than (1 - give) of its touching distance (the sum of the radii) is moved apart
// along the line between the centres, half each, by what it lacks of that distance but at most
// `limit` per call, so a deep overlap glides apart over a few steps instead of jumping. Pairs within
// `give` are left to the sim's own forces, so ordinary contact is untouched. Coincident centres part
// along a direction fixed by their places in the list, so the outcome depends only on the bodies.
// One pass in list order per call (Gauss–Seidel): a crowd settles over a few steps. O(n²): meant
// for a few dozen bodies. Velocities are left alone.
//
//   separateDiscs(lanterns, { give: 0.2, limit: 0.6 * STEP });   // each { x, z, radius, alive }
//   then project onto solid obstacles, so those always win.

/** A body as separateDiscs sees it: its centre on the plane (x, z), radius, and whether it is in play. */
export interface Disc {
  x: number;
  z: number;
  readonly radius: number;
  readonly alive: boolean;
}

export interface SeparateOptions {
  /** Share of the touching distance a pair may sink in before it is moved apart, 0..1. */
  give: number;
  /** Most a pair is moved apart per call (the plane's units). */
  limit: number;
}

export class DiscsError extends Error {}

const GOLDEN = 2.399963229728653;

/** Move apart every pair of live discs that has sunk in deeper than `give`; see the file header. */
export function separateDiscs(discs: readonly Disc[], options: SeparateOptions): void {
  const { give, limit } = options;
  if (!(give >= 0 && give < 1) || !(limit > 0))
    throw new DiscsError(`discs: give must be in [0, 1) and limit > 0, got ${give}, ${limit}`);
  for (let i = 0; i < discs.length; i++) {
    const a = discs[i];
    if (!a?.alive) continue;
    for (let j = i + 1; j < discs.length; j++) {
      const b = discs[j];
      if (!b?.alive) continue;
      const floor = (a.radius + b.radius) * (1 - give);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= floor * floor) continue;
      const d = Math.sqrt(d2);
      // Coincident: part along the pair's own fixed direction.
      const angle = GOLDEN * (i * discs.length + j);
      const nx = d > 1e-9 ? dx / d : Math.cos(angle);
      const nz = d > 1e-9 ? dz / d : Math.sin(angle);
      const half = 0.5 * Math.min(floor - d, limit);
      a.x -= nx * half;
      a.z -= nz * half;
      b.x += nx * half;
      b.z += nz * half;
    }
  }
}
