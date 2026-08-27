export const MACHINE_TOKEN_ENV = "MANIFOLD_MACHINE_TOKEN";
export const MACHINE_TOKEN_FILE_ENV = "MANIFOLD_MACHINE_TOKEN_FILE";

export type MachineTokenEnv = Readonly<Record<string, string | undefined>>;
export type ReadTokenFile = (path: string) => string;

/** Resolves the machine token from exactly one configured source without exposing its bytes. */
export function resolveMachineToken(env: MachineTokenEnv, readFile: ReadTokenFile): string {
  const token = env[MACHINE_TOKEN_ENV];
  const tokenFile = env[MACHINE_TOKEN_FILE_ENV];
  const hasToken = token !== undefined;
  const hasTokenFile = tokenFile !== undefined;

  if (hasToken === hasTokenFile) {
    throw new Error(
      `Exactly one of ${MACHINE_TOKEN_ENV} and ${MACHINE_TOKEN_FILE_ENV} must be set`,
    );
  }

  if (hasToken) {
    if (token === "") throw new Error(`${MACHINE_TOKEN_ENV} must not be empty`);
    return token;
  }

  const path = tokenFile as string;
  let contents: string;
  try {
    contents = readFile(path);
  } catch {
    throw new Error(`Unable to read machine token file at ${JSON.stringify(path)}`);
  }

  const trimmed = contents.trim();
  if (trimmed === "") {
    throw new Error(`Machine token file at ${JSON.stringify(path)} is empty`);
  }
  return trimmed;
}
