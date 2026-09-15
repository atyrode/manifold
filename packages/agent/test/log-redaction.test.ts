import { expect, test } from "bun:test";
import { createAgentLogSink, type AgentLogRecord } from "../src/log.ts";

test("delivers recursively redacted records while retaining diagnostic fields", () => {
  const emitted: string[] = [];
  const source: AgentLogRecord = {
    ts: 1_726_000_000_000,
    level: "warn",
    evt: "socket_backpressure",
    machineId: "machine-7",
    errorCode: "E_BACKPRESSURE",
    retryCount: 3,
    ToKeN: "top-level-token",
    details: {
      jobId: "job-42",
      statusCode: 429,
      byteCount: 65_536,
      apiKEY: "nested-key",
      AUTHorization: "Bearer nested-token",
      sessionBeArEr: "nested-bearer",
      clientSECRET: "nested-secret",
      userPassWORD: "nested-password",
      databasePASSWD: "nested-passwd",
      serviceCREDENTIAL: "nested-credential",
      loginPassPhrase: "nested-passphrase",
      DaTa: "terminal bytes",
      eNV: { PRIVATE: "value" },
      PAYload: { command: "sensitive" },
      terminalDATA: "more terminal bytes",
      metadata: "retained because terminal-content names are exact",
      attempts: [
        {
          attemptId: "attempt-1",
          resultCode: "RETRY",
          responseCount: 2,
          AccessToKeN: "array-token",
          Data: "array terminal bytes",
        },
        {
          attemptId: "attempt-2",
          resultCode: "OK",
          responseCount: 1,
          nested: {
            signingKEY: "deep-key",
            TerminalData: "deep terminal bytes",
            workerId: "worker-9",
          },
        },
      ],
    },
  };
  const sink = createAgentLogSink((line) => emitted.push(line));

  sink(source);

  expect(emitted).toHaveLength(1);
  const line = emitted[0];
  expect(line?.slice(-1)).toBe("\n");
  expect(line?.slice(0, -1)).not.toContain("\n");
  const received: unknown = JSON.parse(line ?? "");
  expect(received).toEqual({
    ts: 1_726_000_000_000,
    level: "warn",
    evt: "socket_backpressure",
    machineId: "machine-7",
    errorCode: "E_BACKPRESSURE",
    retryCount: 3,
    details: {
      jobId: "job-42",
      statusCode: 429,
      byteCount: 65_536,
      metadata: "retained because terminal-content names are exact",
      attempts: [
        {
          attemptId: "attempt-1",
          resultCode: "RETRY",
          responseCount: 2,
        },
        {
          attemptId: "attempt-2",
          resultCode: "OK",
          responseCount: 1,
          nested: {
            workerId: "worker-9",
          },
        },
      ],
    },
  });
});

test("does not scan credential-looking prose in a safe-named string", () => {
  const emitted: string[] = [];
  const message =
    "authorization: Bearer visible-in-prose; password=hunter2; credential=demo; token=example";

  const sink = createAgentLogSink((line) => emitted.push(line));
  sink({
    ts: 1_726_000_000_001,
    level: "info",
    evt: "socket_backpressure",
    message,
  });

  expect(emitted).toHaveLength(1);
  const line = emitted[0];
  expect(line?.slice(-1)).toBe("\n");
  expect(line?.slice(0, -1)).not.toContain("\n");
  const received: unknown = JSON.parse(line ?? "");

  expect(received).toEqual({
    ts: 1_726_000_000_001,
    level: "info",
    evt: "socket_backpressure",
    message,
  });
});
