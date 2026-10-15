// The Scenes view's thumbnails: each scene at its defaults, rendered once by scripts/thumbs.ts and
// committed under concepts/landing/thumbs/ (served beside the page). A scene without one (a build
// from before them, a new scene) shows a stand-in: a small ordered-dither glow in its accent.
import type { SceneId } from "../scenes/index.ts";
import type { FamilyId } from "./families.ts";

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** Where a family's stand-in puts its glow (x, y in 0..1) and how wide it spreads. */
const GLOW: Record<FamilyId, [number, number, number]> = {
  sky: [0.68, 0.3, 0.55],
  water: [0.5, 0.62, 0.75],
  land: [0.3, 0.42, 0.7],
  matter: [0.5, 0.5, 0.45],
  life: [0.62, 0.55, 0.5],
};

/** The committed thumbnail's URL, relative to the page (so a pinned build loads its own). */
export function thumbUrl(scene: SceneId): string {
  return `thumbs/${scene}.webp`;
}

/** The stand-in for a scene without a thumbnail. */
export function standIn(accent: string, family: FamilyId): string {
  const width = 48;
  const height = 30;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(width, height);
  const value = Number.parseInt(accent.replace("#", "").slice(0, 6), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
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
  return canvas.toDataURL("image/png");
}
