// Landing/loading/instance-face concept lab. Bun bundles index.html on demand with HMR, so edits
// in this directory appear live behind whatever proxy fronts the loopback port.
//
//   bun concepts/landing/serve.ts [port]     (default 7920, loopback only)
import index from "./index.html";

const port = Number(process.argv[2] ?? 7920);
const art = new URL("./art/", import.meta.url);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: { hmr: true, console: true },
  routes: {
    "/": index,
    "/art/:file": (request) => {
      const { file } = request.params;
      if (!/^[a-z0-9-]+\.jpg$/.test(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(new URL(file, art)), {
        headers: { "cache-control": "public, max-age=3600" },
      });
    },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`evt=landing.serve url=${server.url}`);
