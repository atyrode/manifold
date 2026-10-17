// A picture the pointer drags about, tethered to its home: within an envelope it follows the hand
// exactly; past it the drag meets a rubber band's growing resistance and can never carry the picture
// further than `give` beyond; let go and any overshoot springs back within a moment while the rest
// drifts home on its half-life. So a picture can be nudged anywhere on screen but never flung off.
//
//   rubberBand(x, limit, give)   x within ±limit as it is; beyond, eased toward ±(limit + give)
//                                (slope 1 at the limit, never reaching limit + give)
//   new ElasticPan({ halfLife, give, snap })
//     offset                     the pan, [x, y] in the caller's units (home is [0, 0])
//     drag(dx, dy, ex, ey)       held: the pointer moved by (dx, dy); the envelope is ±ex, ±ey.
//                                The stretch is path independent: drag out and back, the picture
//                                comes back under the same point of the hand.
//     release(dt, ex, ey)        not held, dt seconds: overshoot past the envelope halves every `snap`
//                                seconds, the whole offset every `halfLife` (inside the envelope
//                                exactly `offset *= 0.5 ** (dt / halfLife)`)
//
// Usage (fractal: the picture's centre kept within the frame, in content units of half a height):
//   readonly #pan = new ElasticPan({ halfLife: 6, give: 0.3, snap: 0.25 });
//   if (dragging && last) this.#pan.drag(at[0] - last[0], at[1] - last[1], aspect, 1);
//   else if (!dragging) this.#pan.release(dt, aspect, 1);
//   const [panX, panY] = this.#pan.offset;

export function rubberBand(x: number, limit: number, give: number): number {
  const over = Math.abs(x) - limit;
  if (over <= 0) return x;
  return Math.sign(x) * (limit + give * (1 - Math.exp(-over / give)));
}

/** The stretch that `rubberBand` maps to p (p short of limit + give: an offset past it is taken at its reach). */
function unband(p: number, limit: number, give: number): number {
  const over = Math.abs(p) - limit;
  if (over <= 0) return p;
  return Math.sign(p) * (limit - give * Math.log(1 - Math.min(over / give, 0.999)));
}

/** `value` with its overshoot past ±limit scaled by `back`. */
function pullIn(value: number, limit: number, back: number): number {
  const over = Math.abs(value) - limit;
  return over > 0 ? Math.sign(value) * (limit + over * back) : value;
}

export interface ElasticPanOptions {
  /** Seconds for a released pan to drift halfway home. */
  halfLife: number;
  /** How far past the envelope a drag can stretch the pan (approached, never reached). */
  give: number;
  /** Seconds for a released overshoot past the envelope to halve. */
  snap: number;
}

export class ElasticPan {
  readonly offset: [number, number] = [0, 0];
  readonly #options: ElasticPanOptions;
  /** The unbounded stretch of the drag in hand; undefined while not held. */
  #stretch: [number, number] | undefined;

  constructor(options: ElasticPanOptions) {
    this.#options = options;
  }

  drag(dx: number, dy: number, ex: number, ey: number): void {
    const { give } = this.#options;
    const stretch = this.#stretch ?? [
      unband(this.offset[0], ex, give),
      unband(this.offset[1], ey, give),
    ];
    stretch[0] += dx;
    stretch[1] += dy;
    this.#stretch = stretch;
    this.offset[0] = rubberBand(stretch[0], ex, give);
    this.offset[1] = rubberBand(stretch[1], ey, give);
  }

  release(dt: number, ex: number, ey: number): void {
    this.#stretch = undefined;
    if (dt <= 0) return;
    const { halfLife, snap } = this.#options;
    const home = Math.pow(0.5, dt / halfLife);
    const back = Math.pow(0.5, dt / snap);
    this.offset[0] = pullIn(this.offset[0] * home, ex, back);
    this.offset[1] = pullIn(this.offset[1] * home, ey, back);
  }
}
