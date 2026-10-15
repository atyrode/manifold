import { expect, spyOn, test } from "bun:test";
import { readPrefs } from "./prefs.ts";

const defaults = { open: false, explain: false, sections: {}, panels: {}, sheet: { open: true } };

test("no stored preferences read as the defaults", () => {
  expect(readPrefs(null)).toEqual(defaults);
  expect(readPrefs("{}")).toEqual(defaults);
});

test("a layout from before the Scenes panel became a view keeps everything but that panel", () => {
  const inspector = { dock: "right", ax: "right", x: 0, ay: "top", y: 0, w: 380, h: 700 };
  const transport = { dock: "bottom", ax: "center", x: 0, ay: "bottom", y: 16, w: 640, h: 44 };
  const stored = JSON.stringify({
    open: true,
    explain: true,
    sections: { "pond:koi": false, look: true, broken: "yes" },
    panels: {
      browser: { dock: "float", ax: "left", x: 16, ay: "top", y: 16, w: 252, h: 808 },
      inspector,
      transport,
    },
    sheet: { tab: "browser", open: false },
  });
  expect(readPrefs(stored)).toEqual({
    open: true,
    explain: true,
    sections: { "pond:koi": false, look: true },
    panels: { inspector, transport },
    sheet: { open: false },
  });
});

test("unreadable or malformed preferences fall back without throwing", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(readPrefs("{not json")).toEqual(defaults);
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
  expect(readPrefs("3")).toEqual(defaults);
  expect(readPrefs("null")).toEqual(defaults);
  expect(readPrefs(JSON.stringify({ panels: [1, 2], sheet: "up", sections: 4 }))).toEqual(defaults);
});
