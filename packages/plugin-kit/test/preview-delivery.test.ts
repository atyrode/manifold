import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PREVIEWS = `${import.meta.dir}/../../../infra/previews`;
const URL = "https://example.test/releases/counter.manifold-plugin.json";
const SHA = "a".repeat(64);
const CONTAINER = "b".repeat(64);

// Exercise both public script boundaries, replacing only commands that could install or
// contact Docker. Every invocation owns its env, checkout, registry, lock and command log.
async function deliver(entry: "receiver" | "preview", words: string[]) {
  const dir = mkdtempSync(`${tmpdir()}/plugin-preview-delivery-`);
  try {
    mkdirSync(`${dir}/bin`);
    mkdirSync(`${dir}/dev`);
    mkdirSync(`${dir}/previews`);
    await Bun.write(
      `${dir}/previews/env`,
      `PREVIEW_DOMAIN=example.test\nPREVIEW_DEV_CHECKOUT=${dir}/dev\nPREVIEW_DEV_PORT=7912\n`,
    );
    const bash = Bun.which("bash");
    if (!bash) throw new Error("preview delivery checks require bash");
    for (const [name, body] of Object.entries({
      docker: `printf '%s\\0' "$@" >> "$HOME/docker-args"\nprintf '%s\\n' '${CONTAINER}'`,
      bun: `printf '%s\\0' "$@" >> "$HOME/bun-args"`,
    })) {
      await Bun.write(`${dir}/bin/${name}`, `#!${bash}\nset -euo pipefail\n${body}\n`);
      chmodSync(`${dir}/bin/${name}`, 0o755);
    }
    const command = Bun.spawn(
      [bash, `${PREVIEWS}/${entry}.sh`, ...(entry === "preview" ? words : [])],
      {
        env: {
          HOME: dir,
          PATH: `${dir}/bin:${process.env.PATH ?? ""}`,
          PREVIEW_HOME: `${dir}/previews`,
          ...(entry === "receiver" ? { SSH_ORIGINAL_COMMAND: words.join(" ") } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    const args = async (name: string) => {
      const file = Bun.file(`${dir}/${name}-args`);
      return (await file.exists()) ? (await file.text()).split("\0").slice(0, -1) : [];
    };
    return { code, stdout, stderr, docker: await args("docker"), bun: await args("bun") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const entry of ["receiver", "preview"] as const) {
  describe(`${entry} plugin delivery`, () => {
    test("refuses malformed delivery before Docker or installation", async () => {
      const malformed = [
        ["plugin", URL, SHA, "--unknown"],
        ["plugin", URL, SHA, "--hardened", "extra"],
        ["plugin", "http://example.test/counter.manifold-plugin.json", SHA, "--hardened"],
        ["plugin", URL, "not-a-sha", "--hardened"],
        ["plugin", URL, SHA, "--hardened\n"],
      ];
      for (const words of malformed) {
        const result = await deliver(entry, words);
        expect(result.code).toBe(2);
        expect(result.docker).toEqual([]);
        expect(result.bun).toEqual([]);
      }
    });
  });
}
