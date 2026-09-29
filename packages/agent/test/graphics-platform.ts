import { afterAll, beforeAll } from "bun:test";

const keys = ["document", "window", "createImageBitmap", "ImageData"] as const;
type Platform = Record<string, PropertyDescriptor | undefined>;
let memoryPlatform: Platform | undefined;

function restore(platform: Platform): void {
  for (const [key, descriptor] of Object.entries(platform)) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
}

/** The agent's one-time canvas adapter belongs to these PTY tests, not later web imports. */
export function isolateGraphicsPlatform(): void {
  let previous: Platform;
  beforeAll(() => {
    previous = Object.fromEntries(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    // The real adapter initializes once per process; later PTY files reuse its descriptors.
    if (memoryPlatform !== undefined) restore(memoryPlatform);
  });
  afterAll(() => {
    memoryPlatform = Object.fromEntries(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    restore(previous);
  });
}
