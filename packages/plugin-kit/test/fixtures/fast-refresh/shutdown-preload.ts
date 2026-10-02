import { mock } from "bun:test";
import * as http from "node:http";

// Loaded only in the disposable CLI child. Keep real files, sockets and watchers;
// hold one package lookup until the real listener's close handlers have finished.
const metadataPath = process.env["REFRESH_TEST_DEPENDENCY_METADATA"];
if (metadataPath === undefined) throw new Error("missing dependency metadata fixture");
const resume = Promise.withResolvers<void>();
let held = false;
let released = false;
const file = Bun.file;
Bun.file = (path, options) => {
  const result =
    typeof path === "number"
      ? file(path, options)
      : typeof path === "string" || path instanceof URL
        ? file(path, options)
        : file(path, options);
  if (path !== metadataPath) return result;
  const json = result.json.bind(result);
  result.json = async () => {
    const metadata: unknown = await json();
    if (!held) {
      held = true;
      console.log(JSON.stringify({ event: "fixture-dependency-held" }));
    }
    await resume.promise;
    return metadata;
  };
  return result;
};

const actualHttp = { ...http };
mock.module("node:http", () => ({
  ...actualHttp,
  createServer(...args: Parameters<typeof http.createServer>) {
    const server = actualHttp.createServer(...args);
    server.once("close", () => {
      if (!held || released) return;
      released = true;
      // The CLI's listener-close handler drains its watcher list synchronously.
      // Resume after all handlers, without guessing how long socket close takes.
      queueMicrotask(() => {
        console.log(JSON.stringify({ event: "fixture-listener-closed" }));
        resume.resolve();
      });
    });
    return server;
  },
}));
