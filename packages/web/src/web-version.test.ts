import { describe, expect, test } from "bun:test";
import { WEB_BUILD, WEB_CHANGELOG, WEB_CHANNEL, WEB_VERSION, WEB_VERSION_LABEL } from "./web-version.ts";

describe("web version metadata", () => {
  test("the displayed label is the build, and a development build says so", () => {
    // Outside vite nothing injects an identity, which is exactly the development case.
    expect(WEB_CHANNEL).toBe("development");
    expect(WEB_VERSION_LABEL).toBe(`development · v${WEB_BUILD}`);
    expect(WEB_BUILD).not.toBe("");
  });

  test("the current release heads a non-empty changelog", () => {
    expect(WEB_CHANGELOG[0]?.version).toBe(WEB_VERSION);
    expect(WEB_CHANGELOG[0]?.changes.length).toBeGreaterThan(0);
  });
});
