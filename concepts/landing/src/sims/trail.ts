// A fading field of where the pointer has been: stir water, melt frost, wake the plankton.
// Values 0..1 in an r8 grid (row 0 = uv.y 0), deposited along the pointer's path and decaying.

export class TrailField {
  readonly width: number;
  readonly height: number;
  /** r8 texels, rows bottom to top. */
  readonly data: Uint8Array;
  readonly #value: Float32Array;
  #last: { x: number; y: number } | undefined;
  /** Bumped whenever `data` changes, so uploads can be skipped when nothing moved. */
  version = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
    this.#value = new Float32Array(width * height);
  }

  /**
   * Deposit along the segment from the previous point to (x, y), in uv (0..1, y up). `radius` is in
   * uv heights; `strength` 0..1 is added per deposit, capped at 1.
   */
  stroke(x: number, y: number, radius: number, strength: number, aspect: number): void {
    const from = this.#last ?? { x, y };
    this.#last = { x, y };
    const dx = (x - from.x) * aspect;
    const dy = y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(radius * 0.5, 1e-4)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.#splat(from.x + (x - from.x) * t, from.y + (y - from.y) * t, radius, strength / Math.sqrt(steps), aspect);
    }
    this.version++;
  }

  /** End the current stroke: the next one starts fresh instead of joining it. */
  lift(): void {
    this.#last = undefined;
  }

  /** Fade everything with the given half-life in seconds. */
  decay(dt: number, halfLife: number): void {
    if (dt <= 0) return;
    const keep = Math.pow(0.5, dt / Math.max(halfLife, 1e-3));
    const value = this.#value;
    const data = this.data;
    let any = false;
    for (let i = 0; i < value.length; i++) {
      const v = (value[i] ?? 0) * keep;
      value[i] = v < 0.002 ? 0 : v;
      const byte = Math.round(Math.min(1, value[i] ?? 0) * 255);
      if (byte !== data[i]) {
        data[i] = byte;
        any = true;
      }
    }
    if (any) this.version++;
  }

  #splat(x: number, y: number, radius: number, strength: number, aspect: number): void {
    const w = this.width;
    const h = this.height;
    const cx = x * w;
    const cy = y * h;
    const rx = (radius / aspect) * w;
    const ry = radius * h;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    const value = this.#value;
    const data = this.data;
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot((i + 0.5 - cx) / Math.max(rx, 1e-3), (j + 0.5 - cy) / Math.max(ry, 1e-3));
        if (d >= 1) continue;
        const k = j * w + i;
        const fall = (1 - d * d) * (1 - d * d);
        value[k] = Math.min(1, (value[k] ?? 0) + strength * fall);
        data[k] = Math.round((value[k] ?? 0) * 255);
      }
    }
  }
}
