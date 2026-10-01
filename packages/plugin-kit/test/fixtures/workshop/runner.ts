import { devWorkshop } from "../../../src/workshop.ts";
import { discoverPlugins } from "../../../src/dev.ts";
import { packPlugin } from "../../../src/pack.ts";
import { join } from "node:path";

const [root, hub] = process.argv.slice(2);
const ownerKey = process.env.WORKSHOP_TEST_OWNER_KEY;
if (!root || !hub || !ownerKey) throw new Error("workshop test fixture requires its isolated hub");
await devWorkshop({
  root,
  hub: { url: hub, ownerKey },
  port: 0,
  async build(outputDir) {
    console.log(JSON.stringify({ event: "workshop-test-build", outputDir }));
    if (process.env.WORKSHOP_TEST_BLOCK_BUILD === "1") await new Promise<never>(() => {});
    const results = [];
    for (const plugin of await discoverPlugins(root)) {
      results.push(await packPlugin(plugin.dir, join(outputDir, `${plugin.id}.manifold-plugin.json`)));
    }
    return results;
  },
});
