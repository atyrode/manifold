// The level camera of the side-on outdoor scenes: an eye `eye` above level ground looking straight
// ahead, the horizon at screen height `horizon` (uv.y), `focal` screen heights per unit of ray slope
// (focal = 0.5 / tan(vfov / 2)). The world: x right of the view's centre line, y up from the ground,
// z away from the eye, in the scene's units (about metres). The screen: sx in screen heights from the
// frame's centre line, (uv.x - 0.5) * aspect, and sy = uv.y. The GLSL side of the same camera is
// `viewRay` / `planeAt` in src/shaders/lib.
//
//   new LevelCamera({ horizon, eye, focal })
//   screenX(x, z)            focal · x / z
//   screenY(y, z)            horizon + focal · (y - eye) / z
//   worldX(sx, z)            sx · (z / focal): the point at depth z seen at sx
//   worldY(sy, z)            eye + (sy - horizon) · (z / focal)
//   screenVX(x, z, vx, vz)   how fast screenX moves for a point moving at (vx, vz): d/dt of focal · x / z
//   scale(z)                 focal / z: screen heights per world unit at depth z
//
// Moving a point in the world and projecting it each frame keeps perspective honest: a point that
// recedes at a fixed height slides toward the horizon and the centre line, and the same world speed
// crosses the frame more slowly the farther off it is. Moving a point in screen units and adding
// depth separately (a fixed sx while z grows) carries it out along its view ray instead.
//
// Usage:
//   const camera = new LevelCamera({ horizon: 0.4, eye: 2, focal: 1.18 });
//   seed.x = camera.worldX(headX - 0.5 * aspect, z);  // release where the head is seen
//   seed.y = camera.worldY(headY, z);
//   seed.x += vx * dt; seed.z += vz * dt;             // the air moves it in the world
//   const u = camera.screenX(seed.x, seed.z) / aspect + 0.5;
//
// Scenes with this camera that still inline the formulas: autumn, bees, fireflies, lake.

/** Where the eye stands and how the frame is cut. */
export interface LevelView {
  /** Screen height of the horizon (uv.y). */
  readonly horizon: number;
  /** Eye height above the ground, world units. */
  readonly eye: number;
  /** Screen heights per unit of ray slope: 0.5 / tan(vertical field of view / 2). */
  readonly focal: number;
}

export class LevelCamera implements LevelView {
  readonly horizon: number;
  readonly eye: number;
  readonly focal: number;

  constructor(view: LevelView) {
    this.horizon = view.horizon;
    this.eye = view.eye;
    this.focal = view.focal;
  }

  /** Screen x (screen heights from the centre line) of a point x right of it at depth z. */
  screenX(x: number, z: number): number {
    return (this.focal * x) / z;
  }

  /** Screen y (uv.y) of a point y above the ground at depth z. */
  screenY(y: number, z: number): number {
    return this.horizon + (this.focal * (y - this.eye)) / z;
  }

  /** World x of the point at depth z seen at screen x sx. */
  worldX(sx: number, z: number): number {
    return sx * (z / this.focal);
  }

  /** World height of the point at depth z seen at screen y sy. */
  worldY(sy: number, z: number): number {
    return this.eye + (sy - this.horizon) * (z / this.focal);
  }

  /** Screen heights per second that screen x moves for a point at (x, z) moving at (vx, vz). */
  screenVX(x: number, z: number, vx: number, vz: number): number {
    return (this.focal * (vx - (x * vz) / z)) / z;
  }

  /** Screen heights per world unit at depth z. */
  scale(z: number): number {
    return this.focal / z;
  }
}
