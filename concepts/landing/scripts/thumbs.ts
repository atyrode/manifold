// bun concepts/landing/scripts/thumbs.ts [scene...] — the scene browser's thumbnails.
// Renders every scene (or the named ones) at its defaults in Chromium with software WebGL, page
// copy hidden and passages off, at 240 x 150 CSS pixels so it is dithered as the page draws it,
// lets it settle, and writes concepts/landing/thumbs/<id>.webp. Run it after changing how a scene
// looks at rest and commit the files; the lab falls back to a stand-in for a scene without one.
import { mkdir } from "node:fs/promises";
import { Browser } from "../../../scripts/cdp.ts";
import index from "../index.html";
import { sceneIds } from "../src/scenes/index.ts";

const WIDTH = 240;
const HEIGHT = 150;
/** Seconds a scene runs once its program has built, before it is taken. */
const SETTLE = 6;
/** Seconds to wait for a scene's program (it builds in software, holding the page meanwhile). */
const BUILD = 120;
/** A screenshot answered within this many ms: the page is drawing frames, not building. */
const RESPONSIVE = 1500;

const requested = process.argv.slice(2);
const unknown = requested.filter((id) => !sceneIds.some((scene) => scene === id));
if (unknown.length > 0) throw new Error(`Unknown scenes: ${unknown.join(", ")}`);
const scenes = requested.length > 0 ? sceneIds.filter((id) => requested.includes(id)) : sceneIds;

const out = new URL("../thumbs/", import.meta.url).pathname;
await mkdir(out, { recursive: true });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // As the dev server builds the page, but without hot reload (an edit mid-run must not reload it).
  development: { hmr: false },
  routes: { "/": index },
});
const browser = new Browser();

async function screenshot(format: "png" | "webp"): Promise<Uint8Array> {
  const reply = await browser.send("Page.captureScreenshot", {
    format,
    ...(format === "webp" ? { quality: 82 } : {}),
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  });
  if (reply.error !== undefined)
    throw new Error(`cdp Page.captureScreenshot: ${reply.error.message}`);
  const data = reply.result?.["data"];
  if (typeof data !== "string") throw new Error("cdp Page.captureScreenshot: no image");
  return Buffer.from(data, "base64");
}

try {
  await browser.launch({ softwareWebgl: true });
  const metrics = await browser.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (metrics.error !== undefined) throw new Error(metrics.error.message);
  let total = 0;
  for (const id of scenes) {
    await browser.goto(`${String(server.url)}?scene=${id}&mode=bare&transitions=off`);
    const started = performance.now();
    // While the program builds the page answers nothing (a screenshot then times out): wait for two
    // prompt screenshots in a row.
    const prompt = async () => {
      const asked = performance.now();
      const ok = await screenshot("png").then(
        () => true,
        () => false,
      );
      return ok && performance.now() - asked < RESPONSIVE;
    };
    while (!((await prompt()) && (await Bun.sleep(1000), await prompt()))) {
      if (performance.now() - started > BUILD * 1000)
        throw new Error(`${id} did not start drawing within ${BUILD} s`);
    }
    await Bun.sleep(SETTLE * 1000);
    const image = await screenshot("webp").catch(() => screenshot("webp"));
    await Bun.write(`${out}${id}.webp`, image);
    total += image.byteLength;
    console.error(`evt=landing.thumb scene=${id} bytes=${image.byteLength}`);
  }
  console.error(`evt=landing.thumbs scenes=${scenes.length} bytes=${total}`);
} finally {
  await browser.close();
  await server.stop(true);
}
