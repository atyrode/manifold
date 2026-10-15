// Scene browser thumbnails. A scene's card shows a snapshot of the stage taken once it has settled
// on screen (the lab calls `capture`), kept in this browser's localStorage, so the gallery fills in
// as scenes are visited; until then a dithered swatch in the scene's accent stands in. Snapshots are
// taken right after the renderer's frame (WebGL's buffer is cleared once it is shown).
import type { SceneId } from "../scenes/index.ts";
import type { FamilyId } from "./families.ts";

const STORE_KEY = "landing.lab.thumbs.v1";
const WIDTH = 192;
const HEIGHT = 120;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

function hexRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Where a family's stand-in puts its glow (x, y in 0..1) and how wide it spreads. */
const GLOW: Record<FamilyId, [number, number, number]> = {
  sky: [0.68, 0.3, 0.55],
  water: [0.5, 0.62, 0.75],
  land: [0.3, 0.42, 0.7],
  matter: [0.5, 0.5, 0.45],
  life: [0.62, 0.55, 0.5],
};

export class Thumbs {
  readonly #shots = new Map<string, string>();
  readonly #placeholders = new Map<string, string>();
  readonly #listeners: ((scene: SceneId) => void)[] = [];

  constructor() {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
      if (typeof raw === "object" && raw !== null)
        for (const [scene, src] of Object.entries(raw))
          if (typeof src === "string" && src.startsWith("data:image/")) this.#shots.set(scene, src);
    } catch (error: unknown) {
      console.error("evt=landing.lab_thumbs.unreadable", error);
    }
  }

  /** Called with a scene whenever its snapshot changes. */
  onChange(listener: (scene: SceneId) => void): void {
    this.#listeners.push(listener);
  }

  captured(scene: SceneId): boolean {
    return this.#shots.has(scene);
  }

  /** The snapshot, or the stand-in while there is none. */
  src(scene: SceneId, accent: string, family: FamilyId): string {
    return this.#shots.get(scene) ?? this.#placeholder(scene, accent, family);
  }

  /**
   * A coarse print of the stage (its colours averaged over 16 x 10 cells), to tell one scene's frame
   * from another's; undefined when the stage cannot be read.
   */
  print(stage: HTMLCanvasElement): Uint8ClampedArray | undefined {
    const frame = this.#frame(stage, 16, 10);
    return frame?.getContext("2d")?.getImageData(0, 0, 16, 10).data;
  }

  /**
   * Keep the stage as `scene`'s snapshot, cropped to the card's shape: "kept", or "same" while it
   * still looks like `before` (the frame the switch left, so the scene has not drawn yet), or
   * "unreadable" (a buffer read after it was cleared comes back black).
   */
  capture(
    scene: SceneId,
    stage: HTMLCanvasElement,
    before: Uint8ClampedArray | undefined,
  ): "kept" | "same" | "unreadable" {
    const canvas = this.#frame(stage, WIDTH, HEIGHT);
    const now = this.print(stage);
    if (!canvas || !now || now.every((value, index) => index % 4 === 3 || value === 0))
      return "unreadable";
    if (before && before.length === now.length) {
      let difference = 0;
      for (let i = 0; i < now.length; i++)
        if (i % 4 !== 3) difference += Math.abs((now[i] ?? 0) - (before[i] ?? 0));
      if (difference / ((now.length / 4) * 3) < 6) return "same";
    }
    let src = canvas.toDataURL("image/webp", 0.72);
    if (!src.startsWith("data:image/webp")) src = canvas.toDataURL("image/jpeg", 0.75);
    this.#shots.set(scene, src);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(this.#shots)));
    } catch (error: unknown) {
      console.error("evt=landing.lab_thumbs.unsaved", error);
    }
    for (const listener of this.#listeners) listener(scene);
    return "kept";
  }

  /** The middle of the stage at the card's shape, drawn at width x height. */
  #frame(stage: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement | undefined {
    if (stage.width < 8 || stage.height < 8) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    const scale = Math.max(width / stage.width, height / stage.height);
    const w = width / scale;
    const h = height / scale;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const [x, y] = [(stage.width - w) / 2, (stage.height - h) / 2];
    context.drawImage(stage, x, y, w, h, 0, 0, width, height);
    return canvas;
  }

  /** A small ordered-dither glow in the scene's accent over the night page, drawn once per scene. */
  #placeholder(scene: SceneId, accent: string, family: FamilyId): string {
    const cached = this.#placeholders.get(scene);
    if (cached) return cached;
    const width = 48;
    const height = 30;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return "";
    const image = context.createImageData(width, height);
    const [r, g, b] = hexRgb(accent);
    const [gx, gy, spread] = GLOW[family];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const dx = (x / width - gx) / spread;
        const dy = (y / height - gy) / (spread * 0.9);
        const light = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) ** 1.6 * 0.85;
        const on = light > ((BAYER4[(y % 4) * 4 + (x % 4)] ?? 0) + 0.5) / 16;
        const at = (y * width + x) * 4;
        image.data[at] = on ? r : 9;
        image.data[at + 1] = on ? g : 10;
        image.data[at + 2] = on ? b : 14;
        image.data[at + 3] = 255;
      }
    context.putImageData(image, 0, 0);
    const src = canvas.toDataURL("image/png");
    this.#placeholders.set(scene, src);
    return src;
  }
}
