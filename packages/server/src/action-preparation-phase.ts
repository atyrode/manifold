import { AsyncLocalStorage } from "node:async_hooks";
import { ServiceError } from "./auth.ts";

const preparation = new AsyncLocalStorage<{ violated: boolean }>();

/** Preparation descendants never acquire effect authority, even after preparation returns. */
export function requireActionEffects(): void {
  const phase = preparation.getStore();
  if (phase === undefined) return;
  phase.violated = true;
  throw new ServiceError("forbidden", "action preparation has no mutable host context");
}

/** Refuse a swallowed effect attempt without retiring an unrelated admitted context's lease. */
export async function runActionPreparation<T>(prepare: () => Promise<T>): Promise<T> {
  const phase = { violated: false };
  const result = await preparation.run(phase, prepare);
  if (phase.violated)
    throw new ServiceError("forbidden", "action preparation attempted mutable host access");
  return result;
}
