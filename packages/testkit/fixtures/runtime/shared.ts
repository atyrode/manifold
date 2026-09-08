export const PLUGIN = "fixture.runtime";
export const OPERATION = `${PLUGIN}.run`;
export const LOCATION = `${PLUGIN}.witness`;
export const limits = {
  timeoutMs: 30_000,
  memoryBytes: 128 * 1024 * 1024,
  processes: 32,
  outputBytes: 1024,
};
