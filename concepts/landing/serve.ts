// Landing/loading/instance-face concept lab, served on loopback for a fronting proxy.
//
//   bun concepts/landing/serve.ts [port]          public: rebundles on edit, refresh to see it
//   bun concepts/landing/serve.ts [port] --hmr    local: adds hot reload
//
// Bun's HMR server refuses any Host/Origin other than its own bind address, so hot reload only
// works when the browser talks to the loopback port directly.
import index from "./index.html";

const hmr = process.argv.includes("--hmr");
const port = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) ?? 7920);
const art = new URL("./art/", import.meta.url);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: { hmr, console: hmr },
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
