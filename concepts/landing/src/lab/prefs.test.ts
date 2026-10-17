import { expect, spyOn, test } from "bun:test";
import { readPrefs, type Prefs } from "./prefs.ts";

const defaults: Prefs = {
  open: false,
  presentation: "expanded",
  explain: false,
  keepWorld: false,
  sections: {},
  panels: {},
  sheet: { open: true },
};

test("no stored preferences read as the defaults", () => {
  expect(readPrefs(null)).toEqual(defaults);
  expect(readPrefs("{}")).toEqual(defaults);
});

test("an older layout keeps everything but the panels it no longer has", () => {
  const inspector = { dock: "right", ax: "right", x: 0, ay: "top", y: 0, w: 380, h: 700 };
  const transport = { dock: "bottom", ax: "center", x: 0, ay: "bottom", y: 16, w: 640, h: 44 };
  const stored = JSON.stringify({
    open: true,
    explain: true,
    keepWorld: true,
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
    presentation: "expanded",
    explain: true,
    keepWorld: true,
    sections: { "pond:koi": false, look: true },
    panels: { inspector },
    sheet: { open: false },
  });
});

test("the compact presentation and the bar's place are kept", () => {
  const bar = { dock: "float", ax: "center", x: 0, ay: "bottom", y: 16, w: 640, h: 44 };
  expect(readPrefs(JSON.stringify({ presentation: "compact", panels: { bar } }))).toEqual({
    ...defaults,
    presentation: "compact",
    panels: { bar },
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
  expect(
    readPrefs(
      JSON.stringify({
        panels: [1, 2],
        sheet: "up",
        sections: 4,
        keepWorld: "yes",
        presentation: "tiny",
      }),
    ),
  ).toEqual(defaults);
});
