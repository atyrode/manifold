// What every part of the slime mould shares: its error, the trail grid the sim's fields run on, the
// petri dish, the flake slots, the specks' lifetime and trail units, and the distance field's "far".
import { gridSize } from "../../sims/gpu.ts";

export class PhysarumError extends Error {}

export const TAU = Math.PI * 2;

/**
 * Trail texels across the frame's shorter side, and at most along its longer one. Fine enough that
 * the specks occupy only ~15% of the texels (see physarumAgentCounts); the view's blur draws a
 * one-texel filament as a soft line ~2 cells wide.
 */
const TRAIL_SHORT = 400;
const TRAIL_LONG = 960;
/** Trail texels beyond each edge of the frame: the specks bounce off the grid's edge out of sight. */
export const PHYSARUM_MARGIN = 10;
/** Flake slots: the shader's loop and the passes' uniform arrays. */
export const PHYSARUM_MAX_FOOD = 32;
/** The petri dish's radius as a share of the frame's half-diagonal: its glass wall cuts the corners. */
export const PHYSARUM_DISH = 0.9;
/** Distance off the network, screen heights (the distance field's value where no vein leads). */
export const PHYSARUM_FAR = 8;
/** Steps a speck lives without reaching food (a minute at 40 steps a second): it roams the whole dish. */
export const LIFE = 2400;
/** Trail one speck per texel keeps up at the reference population. */
export const AGENT_UNIT = 0.1;

/** The dish's radius in screen heights for a frame aspect (its centre is the frame's). */
export const dishRadius = (aspect: number): number => (PHYSARUM_DISH * Math.hypot(aspect, 1)) / 2;

export interface Point {
  x: number;
  y: number;
}

/** An element the code has just checked is there. */
export function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new PhysarumError(`physarum: no item ${index} of ${items.length}`);
  return value;
}

/** The trail grid for a frame aspect: square texels, the frame plus a margin on every side. */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly envWidth: number;
  readonly envHeight: number;

  constructor(aspect: number) {
    let frame = gridSize(aspect, TRAIL_SHORT);
    const long = Math.max(frame.width, frame.height);
    if (long > TRAIL_LONG) frame = gridSize(aspect, (TRAIL_SHORT * TRAIL_LONG) / long);
    this.frameWidth = frame.width;
    this.frameHeight = frame.height;
    this.width = frame.width + 2 * PHYSARUM_MARGIN;
    this.height = frame.height + 2 * PHYSARUM_MARGIN;
    this.envWidth = Math.ceil(this.width / 2);
    this.envHeight = Math.ceil(this.height / 2);
  }

  /** Trail texels per screen height. */
  get perHeight(): number {
    return this.frameHeight;
  }

  /** The dish's radius in trail texels; its centre is the frame's, (trailX(0.5), trailY(0.5)). */
  get dish(): number {
    return dishRadius(this.frameWidth / this.frameHeight) * this.frameHeight;
  }

  /** Trail texel coordinates of a point in screen uv. */
  trailX(u: number): number {
    return PHYSARUM_MARGIN + u * this.frameWidth;
  }

  trailY(v: number): number {
    return PHYSARUM_MARGIN + v * this.frameHeight;
  }

  /** The fields' uv (0..1 over the whole grid, margins included) of a point in screen uv. */
  domainX(u: number): number {
    return this.trailX(u) / this.width;
  }

  domainY(v: number): number {
    return this.trailY(v) / this.height;
  }

  /** Half-resolution texel coordinates of a point in screen uv. */
  envX(u: number): number {
    return this.domainX(u) * this.envWidth;
  }

  envY(v: number): number {
    return this.domainY(v) * this.envHeight;
  }

  same(other: Grid): boolean {
    return other.width === this.width && other.height === this.height;
  }
}
