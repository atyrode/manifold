import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TERMINAL_GRAPHICS_PREFIX, encodeTerminalRgba } from "@manifold/protocol";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";

/** A solid red Sixel whose raster attributes declare its exact extent. */
function sixel(width: number, height: number): string {
  const bands = Array.from(
    { length: Math.ceil(height / 6) },
    (_, band) =>
      `!${String(width)}${String.fromCharCode(63 + ((1 << Math.min(6, height - band * 6)) - 1))}`,
  ).join("-");
  return `\x1bPq"1;1;${String(width)};${String(height)}#1;2;100;0;0#1${bands}\x1b\\`;
}

/** A host graphics envelope as a retained terminal host of `version` serializes it. */
function envelope(version: 1 | 2, images: readonly object[] = []): string {
  const state = {
    version,
    scrolling: true,
    palette: Buffer.alloc(1024).toString("base64"),
    paletteLimit: 256,
    images,
  };
  return `\x1b]1337;${TERMINAL_GRAPHICS_PREFIX}${JSON.stringify(state)}\x07`;
}

interface Uploads {
  readonly put: number;
  readonly readback: number;
}

async function withGraphicsFixture(run: (browser: Browser) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-terminal-graphics-"));
  const plugin = resolve(import.meta.dir, "..");
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  try {
    const entry = join(scratch, "fixture.js");
    const output = join(scratch, "dist");
    // Counts the actual canvas work the pinned addon and this adapter perform; the
    // fixture's own pixel inspection uses the original readback and is not counted.
    await Bun.write(
      entry,
      `
      import { Terminal } from ${JSON.stringify(Bun.resolveSync("@xterm/xterm", plugin))};
      import ${JSON.stringify(Bun.resolveSync("@xterm/xterm/css/xterm.css", plugin))};
      import { installTerminalGraphics } from ${JSON.stringify(resolve(plugin, "src/terminal-graphics.ts"))};
      const uploads = { put: 0, readback: 0 };
      const context = CanvasRenderingContext2D.prototype;
      const put = context.putImageData;
      context.putImageData = function (...args) { uploads.put += 1; return put.apply(this, args); };
      const readback = context.getImageData;
      context.getImageData = function (...args) { uploads.readback += 1; return readback.apply(this, args); };
      const host = document.createElement("div");
      document.body.append(host);
      const notices = [];
      const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 100, allowProposedApi: true });
      terminal.open(host);
      const graphics = installTerminalGraphics(terminal, message => notices.push(message));
      const written = data => {
        const { promise, resolve } = Promise.withResolvers();
        terminal.write(data, resolve);
        return promise;
      };
      window.graphicsFixture = {
        notices,
        uploads: () => ({ ...uploads }),
        write: written,
        snapshot(text, cols, rows) {
          const { promise, resolve } = Promise.withResolvers();
          graphics.writeSnapshot(new TextEncoder().encode(text), { cols, rows, revision: null }, resolve);
          return promise;
        },
        line: row => terminal.buffer.active.getLine(row)?.translateToString(true) ?? null,
        painted() {
          const layer = host.querySelector("canvas.xterm-image-layer");
          if (!layer || !layer.width || !layer.height) return 0;
          const data = readback.call(layer.getContext("2d"), 0, 0, layer.width, layer.height).data;
          let painted = 0;
          for (let index = 3; index < data.length; index += 4) if (data[index]) painted += 1;
          return painted;
        },
        firstColor() {
          const layer = host.querySelector("canvas.xterm-image-layer");
          if (!layer || !layer.width || !layer.height) return null;
          const data = readback.call(layer.getContext("2d"), 0, 0, layer.width, layer.height).data;
          for (let index = 0; index < data.length; index += 4)
            if (data[index + 3]) return [data[index], data[index + 1], data[index + 2]];
          return null;
        },
        dispose() { graphics.dispose(); terminal.dispose(); },
      };
      await written("");
      `,
    );
    const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js" || path === "/fixture.css") {
          return new Response(Bun.file(join(output, path.slice(1))), {
            headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" },
          });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:#101010"><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
    await until(
      () => browser.evaluate<boolean>("window.graphicsFixture !== undefined"),
      5_000,
      "the terminal graphics fixture",
    );
    await run(browser);
    expect(browser.drainMessages().filter((message) => message.kind === "exception")).toEqual([]);
    await browser.evaluate<void>("window.graphicsFixture.dispose()");
  } finally {
    try {
      await browser.close();
    } finally {
      try {
        await server?.stop(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
}

const write = (browser: Browser, data: string): Promise<void> =>
  browser.evaluate<void>(`window.graphicsFixture.write(${JSON.stringify(data)})`);
const uploads = (browser: Browser): Promise<Uploads> =>
  browser.evaluate<Uploads>("window.graphicsFixture.uploads()");
const notices = (browser: Browser): Promise<string[]> =>
  browser.evaluate<string[]>("[...window.graphicsFixture.notices]");
const line = (browser: Browser, row: number): Promise<string | null> =>
  browser.evaluate<string | null>(`window.graphicsFixture.line(${String(row)})`);
const painted = (browser: Browser): Promise<number> =>
  browser.evaluate<number>("window.graphicsFixture.painted()");
const firstColor = (browser: Browser): Promise<[number, number, number] | null> =>
  browser.evaluate<[number, number, number] | null>("window.graphicsFixture.firstColor()");

test("images past the former 2,048-cell cliff render without a notice or canvas readback", async () => {
  await withGraphicsFixture(async (browser) => {
    for (const [width, height] of [
      [700, 282],
      [800, 252],
      [840, 420],
    ] as const) {
      await write(browser, `\x1bc${sixel(width, height)}\r\nAFTER ${String(width)}\r\n`);
      await until(async () => (await painted(browser)) > 0, 5_000, `${String(width)} painted`);
      // The cursor advanced past the image's own rows, so following text keeps its place.
      expect(await line(browser, Math.ceil(height / 14))).toBe(`AFTER ${String(width)}`);
    }
    expect(await notices(browser)).toEqual([]);
    expect(await uploads(browser)).toEqual({ put: 3, readback: 0 });
  });
});

test("metadata-proven impossible Sixels are refused before any upload and named once per resource", async () => {
  await withGraphicsFixture(async (browser) => {
    await write(browser, sixel(2100, 300).repeat(20) + sixel(1500, 1500).repeat(20) + "SAFE");
    expect(await uploads(browser)).toEqual({ put: 0, readback: 0 });
    expect(await notices(browser)).toEqual([
      "Inline image not shown: 2100×300 exceeds the 2,048-pixel side limit.",
      "Inline image not shown: 1500×1500 (2,250,000 pixels) exceeds the 2,097,152-pixel limit.",
    ]);
    // Refused images move no cursor; the stream recovers for the next admissible image.
    expect(await line(browser, 0)).toBe("SAFE");
    await write(browser, `\r\n${sixel(70, 42)}\r\nNEXT`);
    await until(async () => (await painted(browser)) > 0, 5_000, "the recovered image painted");
    expect(await line(browser, 4)).toBe("NEXT");
    expect((await uploads(browser)).put).toBe(1);
    await write(browser, "\x1bc");
    await until(async () => (await painted(browser)) === 0, 5_000, "reset released the image");
  });
});

test("a retained version-1 host keeps its own cell admission until a version-2 snapshot replaces it", async () => {
  await withGraphicsFixture(async (browser) => {
    await browser.evaluate<void>(
      `window.graphicsFixture.snapshot(${JSON.stringify(`LEGACY${envelope(1)}`)}, 120, 40)`,
    );
    await write(browser, `\r\n${sixel(700, 282)}\r\nAFTER LEGACY`);
    expect(await notices(browser)).toEqual([
      "Inline image not shown: 700×282 covers 2,100 cells; this terminal host retains 2,048. Upgrade the terminal host for larger images.",
    ]);
    // The old host refused it too, so neither peer moved the cursor or uploaded pixels.
    expect(await line(browser, 2)).toBe("AFTER LEGACY");
    expect(await uploads(browser)).toEqual({ put: 0, readback: 0 });
    await browser.evaluate<void>(
      `window.graphicsFixture.snapshot(${JSON.stringify(`CURRENT${envelope(2)}`)}, 120, 40)`,
    );
    await write(browser, `\r\n${sixel(700, 282)}\r\nAFTER CURRENT`);
    await until(async () => (await painted(browser)) > 0, 5_000, "the version-2 image painted");
    expect(await line(browser, 22)).toBe("AFTER CURRENT");
    expect(await notices(browser)).toHaveLength(1);
  });
});

test("a version-1 host's refused Sixel still updates the shared palette, as that host's decoder did", async () => {
  await withGraphicsFixture(async (browser) => {
    await browser.evaluate<void>(
      `window.graphicsFixture.snapshot(${JSON.stringify(`LEGACY${envelope(1)}`)}, 120, 40)`,
    );
    // Entry 1 starts green; the refused 2,100-cell fixture redefines it red before refusal.
    await write(browser, '\x1bPq"1;1;7;6#1;2;0;100;0#1!7~\x1b\\\r\n');
    await write(browser, `${sixel(700, 282)}\x1b[2J\x1b[H`);
    await until(async () => (await painted(browser)) === 0, 5_000, "erasure removed the images");
    await write(browser, '\x1bPq"1;1;7;6#1!7~\x1b\\\r\nREUSED');
    await until(
      async () => (await painted(browser)) > 0,
      5_000,
      "the palette-reusing image painted",
    );
    const [red = 0, green = 0] = (await firstColor(browser)) ?? [];
    expect(red).toBeGreaterThan(200);
    expect(green).toBeLessThan(50);
  });
});

test("a version-2 snapshot restores retained pixels at their recorded cells", async () => {
  const rgba = new Uint8Array(14 * 14 * 4);
  for (let pixel = 0; pixel < 14 * 14; pixel++) rgba.set([0, 200, 0, 255], pixel * 4);
  const encoded = encodeTerminalRgba(rgba, rgba.length);
  if (encoded === undefined) throw new Error("A 14x14 fixture must encode");
  // Two canonical tiles on row 1, columns 3 and 4: little-endian row, column, tile triples.
  const cells = Buffer.alloc(12);
  cells.writeUInt16LE(1, 0);
  cells.writeUInt16LE(3, 2);
  cells.writeUInt16LE(0, 4);
  cells.writeUInt16LE(1, 6);
  cells.writeUInt16LE(4, 8);
  cells.writeUInt16LE(1, 10);
  const image = {
    id: 0,
    width: 14,
    height: 14,
    format: encoded.format,
    data: Buffer.from(encoded.bytes).toString("base64"),
    buffer: "normal",
    cells: cells.toString("base64"),
  };
  await withGraphicsFixture(async (browser) => {
    await browser.evaluate<void>(
      `window.graphicsFixture.snapshot(${JSON.stringify(`TOP\r\nROW${envelope(2, [image])}`)}, 120, 40)`,
    );
    await until(async () => (await painted(browser)) > 0, 5_000, "restored pixels painted");
    expect(await notices(browser)).toEqual([]);
    // Live output after the watermark continues on the restored text grid.
    await write(browser, "\r\nLIVE");
    expect(await line(browser, 2)).toBe("LIVE");
  });
});

test("legacy Sixel input keeps the retained host's code-point admission and cursor placement", async () => {
  await withGraphicsFixture(async (browser) => {
    await browser.evaluate<void>(
      `window.graphicsFixture.snapshot(${JSON.stringify(envelope(1))}, 120, 40)`,
    );
    // Non-ASCII passthrough is ignored by the decoder but charged once by the v1 host.
    // Its UTF-8 length exceeds the old byte gate, while its code-point charge does not.
    const image = sixel(70, 42).replace("\x1b\\", `${"\u00a0".repeat(66_000)}\x1b\\`);
    await write(browser, `${image}\r\nAFTER LEGACY INPUT`);
    expect(await notices(browser)).toEqual([]);
    await until(async () => (await painted(browser)) > 0, 5_000, "legacy input image painted");
    expect(await line(browser, 3)).toBe("AFTER LEGACY INPUT");
  });
}, 15_000);

test("a sub-pixel inline fit stays silent and preserves following text", async () => {
  await withGraphicsFixture(async (browser) => {
    await browser.evaluate<void>(`(async () => {
      const image = document.createElement("canvas");
      image.width = 2000;
      image.height = 1;
      const context = image.getContext("2d");
      context.fillStyle = "red";
      context.fillRect(0, 0, 2000, 1);
      const data = image.toDataURL("image/png").split(",")[1];
      await window.graphicsFixture.write(
        "\\x1b]1337;File=inline=1;size=" + atob(data).length + ";width=560px;height=auto:" + data + "\\x07AFTER TINY FIT"
      );
    })()`);
    expect(await notices(browser)).toEqual([]);
    expect(await painted(browser)).toBe(0);
    expect(await uploads(browser)).toEqual({ put: 0, readback: 0 });
    expect(await line(browser, 0)).toBe("AFTER TINY FIT");
  });
});
