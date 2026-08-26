import { describe, expect, test } from "bun:test";
import { WEB_BUILD, WEB_CHANGELOG, WEB_VERSION, WEB_VERSION_LABEL } from "./web-version.ts";

describe("web version metadata", () => {
  test("the displayed label identifies both release and build", () => {
    expect(WEB_VERSION_LABEL).toBe(`v${WEB_VERSION} · ${WEB_BUILD}`);
    expect(WEB_VERSION).not.toBe("");
    expect(WEB_BUILD).not.toBe("");
  });

  test("the current release heads a non-empty changelog", () => {
    expect(WEB_CHANGELOG[0]?.version).toBe(WEB_VERSION);
    expect(WEB_CHANGELOG[0]?.changes.length).toBeGreaterThan(0);
  });
});
