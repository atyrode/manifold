import { test } from "bun:test";

// Only this child imports the fixtures that replace node:https. Other suites, their module
// caches, and their in-flight work never observe the test-process network interception.
if (process.env.GITHUB_PUBLICATION_TEST_PROCESS === "1") {
  // Intentionally exercise a module-loading boundary: static imports would defeat isolation.
  await import("./publication-cases.fixture.ts");
} else {
  test("GitHub publication consumer regressions and packed ordinary/hardened proof", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("MANIFOLD_")),
        ),
        GITHUB_PUBLICATION_TEST_PROCESS: "1",
      },
    });
    // The real subprocess needs a kill deadline, not a timing guess used to make a race pass.
    const deadline = setTimeout(() => child.kill(), 290_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0)
        throw new Error(`publication consumer process exited ${code}\n${stdout}\n${stderr}`);
    } finally {
      clearTimeout(deadline);
      child.kill();
    }
  }, 300_000);
}
