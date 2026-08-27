import { expect, test } from "bun:test";
import {
  MACHINE_TOKEN_ENV,
  MACHINE_TOKEN_FILE_ENV,
  resolveMachineToken,
  type MachineTokenEnv,
} from "../src/machine-token.ts";

const noRead = (): string => {
  throw new Error("unexpected file read");
};

function errorMessage(env: MachineTokenEnv, readFile = noRead): string {
  try {
    resolveMachineToken(env, readFile);
  } catch (error: unknown) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  throw new Error("expected token resolution to fail");
}

test("requires exactly one machine token source", () => {
  const neither = errorMessage({});
  expect(neither).toContain(MACHINE_TOKEN_ENV);
  expect(neither).toContain(MACHINE_TOKEN_FILE_ENV);

  const both = errorMessage({
    [MACHINE_TOKEN_ENV]: "inline-secret",
    [MACHINE_TOKEN_FILE_ENV]: "/run/secrets/manifold-token",
  });
  expect(both).toContain(MACHINE_TOKEN_ENV);
  expect(both).toContain(MACHINE_TOKEN_FILE_ENV);
  expect(both).not.toContain("inline-secret");
});

test("returns the inline token without reading a file", () => {
  expect(resolveMachineToken({ [MACHINE_TOKEN_ENV]: " inline-secret " }, noRead)).toBe(
    " inline-secret ",
  );
});

test("reads the token file once at startup and trims its contents", () => {
  const path = "/run/secrets/manifold-token";
  const reads: string[] = [];
  const token = resolveMachineToken({ [MACHINE_TOKEN_FILE_ENV]: path }, (requestedPath) => {
    reads.push(requestedPath);
    return "\n  file-secret  \t";
  });

  expect(token).toBe("file-secret");
  expect(reads).toEqual([path]);
});

test("bad token files name the path without leaking token bytes", () => {
  const path = "/run/secrets/manifold-token";
  const secret = "never-print-these-token-bytes";

  const unreadable = errorMessage({ [MACHINE_TOKEN_FILE_ENV]: path }, () => {
    throw new Error(`filesystem failure included ${secret}`);
  });
  expect(unreadable).toContain(path);
  expect(unreadable).not.toContain(secret);

  const empty = errorMessage({ [MACHINE_TOKEN_FILE_ENV]: path }, () => " \n\t ");
  expect(empty).toContain(path);
  expect(empty).not.toContain(secret);
});
