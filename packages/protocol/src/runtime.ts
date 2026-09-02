/**
 * Injectable nondeterminism boundary. Server and agent take these as constructor
 * dependencies (defaulting to `defaultRuntime`); the testkit injects seeded ids and a fake
 * clock so golden/replay tests never depend on random wire data. This is a deliberate DI
 * seam — deterministic tests are a repo invariant (AGENTS.md), not a convenience.
 */
export interface RuntimeDeps {
  /** Mints ids for containers, principals, terminals, machines, tokens. */
  newId(): string;
  /** Milliseconds since epoch. */
  now(): number;
}

export const defaultRuntime: RuntimeDeps = {
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
};
