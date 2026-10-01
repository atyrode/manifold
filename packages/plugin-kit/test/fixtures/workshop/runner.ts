import { devWorkshop } from "../../../src/workshop.ts";
import { discoverPlugins } from "../../../src/dev.ts";
import { packPlugin } from "../../../src/pack.ts";
import { join } from "node:path";

const [root, hub] = process.argv.slice(2);
const ownerKey = process.env.WORKSHOP_TEST_OWNER_KEY;
if (!root || !hub || !ownerKey) throw new Error("workshop test fixture requires its isolated hub");
let builds = 0;
await devWorkshop({
  root,
  hub: { url: hub, ownerKey },
  port: 0,
  async build(outputDir) {
    console.log(JSON.stringify({ event: "workshop-test-build", outputDir }));
    if (process.env.WORKSHOP_TEST_BLOCK_BUILD === "1") await new Promise<never>(() => {});
    const results = [];
    const family =
      process.env.WORKSHOP_TEST_CUSTOM_FAMILY === "1"
        ? ((await Bun.file(join(root, ".compiler-family.json")).json()) as string[]).map((dir) => ({
            dir: join(root, dir),
          }))
        : await discoverPlugins(root);
    for (const plugin of family) {
      const manifest = await Bun.file(join(plugin.dir, "manifest.json")).json();
      results.push(
        await packPlugin(plugin.dir, join(outputDir, `${manifest.id}.manifold-plugin.json`)),
      );
    }
    if (++builds === 1 && process.env.WORKSHOP_TEST_BOOTSTRAP_EDIT === "1")
      await Bun.write(join(root, "shared/value.json"), JSON.stringify({ label: "pinned-backend" }));
    return results;
  },
});
