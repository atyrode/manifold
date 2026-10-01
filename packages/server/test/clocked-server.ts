import { defaultRuntime } from "@manifold/protocol";
import { createInterface } from "node:readline";
import { startServer } from "../src/main.ts";

// This disposable child changes only the existing RuntimeDeps wall-clock seam. Network,
// room timers, credential minting and enforcement remain the ordinary server's paths.
let now = Date.now();
const running = await startServer({
  runtime: { newId: () => defaultRuntime.newId(), now: () => now },
});
let stopping = false;
const input = createInterface({ input: process.stdin, terminal: false });
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  input.close();
  void running.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
input.on("line", (line) => {
  try {
    const command = JSON.parse(line) as { id?: unknown; now?: unknown };
    if (
      typeof command.id !== "number" ||
      !Number.isSafeInteger(command.id) ||
      command.id < 1 ||
      typeof command.now !== "number" ||
      !Number.isSafeInteger(command.now) ||
      command.now < now
    ) {
      throw new Error("invalid test-clock advance");
    }
    now = command.now;
    console.log(`manifold test-clock advanced id=${command.id} now=${now}`);
  } catch (error) {
    console.error(error);
    stop();
  }
});
input.on("close", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
