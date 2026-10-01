import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  ISOLATE_MAX_FRAME_BYTES,
  IsolateChildFrameSchema,
  type PluginBundle,
  type PluginManifest,
} from "@manifold/protocol";

/** Inspect the compiled registration, not source syntax or an author-supplied cap assertion. */
export async function inspectServerBinding(
  server: string,
  manifest: PluginManifest,
): Promise<PluginBundle["serverBinding"]> {
  // Raw/retained server entries have no registration inspector and keep their old packing
  // behavior. Missing inspection never grants preparation: the supervisor refuses any
  // preparer not sealed into this artifact.
  if (!server.includes("MANIFOLD_PLUGIN_BINDING")) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "manifold-server-binding-"));
  let child: Subprocess | undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    const entry = join(dir, "server.js");
    await Bun.write(entry, server);
    child = Bun.spawn([process.execPath, "--smol", entry], {
      env: { ...process.env, MANIFOLD_PLUGIN_PIPE_FD: "", MANIFOLD_PLUGIN_BINDING: "1" },
      stdin: new TextEncoder().encode(JSON.stringify(manifest)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const processChild = child;
    deadline = setTimeout(() => processChild.kill(), 10_000);
    const bounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > ISOLATE_MAX_FRAME_BYTES) {
          processChild.kill();
          throw new Error("server binding inspection exceeded its frame budget");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    const [stdout, stderr, code] = await Promise.all([
      bounded(processChild.stdout as ReadableStream<Uint8Array>),
      bounded(processChild.stderr as ReadableStream<Uint8Array>),
      processChild.exited,
    ]);
    if (code !== 0) throw new Error(`server binding inspection failed: ${stderr.slice(0, 2048)}`);
    const lines = stdout.trim().split("\n");
    if (lines.length !== 1)
      throw new Error("server binding inspection did not return one registration");
    const frame = IsolateChildFrameSchema.parse(JSON.parse(lines[0]!));
    if (frame.t === "load_failed")
      throw new Error(`server binding inspection failed: ${frame.error}`);
    if (frame.t !== "loaded")
      throw new Error("server binding inspection did not return a loaded registration");
    if (frame.prepareActions === undefined) return undefined;
    return { prepareActions: frame.prepareActions };
  } finally {
    clearTimeout(deadline);
    if (child !== undefined && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}
