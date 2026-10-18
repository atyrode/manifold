import { expect, test } from "bun:test";
import { README_PATH, REGION, renderDocs } from "./scene-docs.ts";

test("the README's generated tables are the registry's (scripts/scene-docs.ts rewrites them)", async () => {
  const markdown = await Bun.file(README_PATH).text();
  const regions = (text: string) =>
    Object.fromEntries([...text.matchAll(REGION)].map((match) => [match[2], match[0]]));
  expect(regions(await renderDocs(markdown))).toEqual(regions(markdown));
}, 30_000);
