import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  retainedProcessAdmission,
  retainedProcessHoldSentences,
  retainedProcessRefusal,
} from "./retained-process-holds.ts";

const root = resolve(import.meta.dir, "..");
const tooling = join(root, "infra/previews");

/** The deploy path's own classification, called the way `require_retained_server_only` calls it. */
function shellRefusal(code: number, output: string): string {
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      'here=$1; source "$here/common.sh"; source "$here/environment.sh"; retained_process_refusal "$2" "$3"',
      "test",
      tooling,
      String(code),
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString();
}

// Every answer the probe can give, and what a reader is told about it. Both receivers are asked
// the same question and must give the same sentence: the deploy path decides whether a retained
// replacement proceeds and the harness reports the same probe in CI, and they used to agree only
// in reporting everything as owning or unknown processes (#738).
for (const [code, output, expected] of [
  [125, "", "retained incumbent process probe could not be run (exit 125)"],
  [126, "", "retained incumbent process probe could not be run (exit 126)"],
  [127, "", "retained incumbent process probe could not be run (exit 127)"],
  [1, "", "retained incumbent process probe could not be run (exit 1)"],
  [1, "Killed", "retained incumbent process probe did not reach a verdict"],
  [
    0,
    "retained-processes-server-onl",
    "retained incumbent process probe answered outside its vocabulary",
  ],
  [
    1,
    "retained-processes-hold:unclassified-process",
    "retained incumbent a process it cannot classify is running: unclassified-process",
  ],
  [
    1,
    "retained-processes-hold:classifier-fault",
    "retained incumbent the process classifier faulted, which is a defect in the probe and not a finding about this machine: classifier-fault",
  ],
  [
    1,
    "retained-processes-hold:server-process-absent",
    "retained incumbent no hub process is running at PID 1: server-process-absent",
  ],
  [
    1,
    "retained-processes-hold:fingerprint-unreadable-denied",
    "retained incumbent the probe was not permitted to read a process fingerprint: fingerprint-unreadable-denied",
  ],
  // How many reads the kernel refused, which is all this gate discloses beyond its predicate: a
  // denied read cannot tell one hardened process from a container the probe may not read at all,
  // and those want different repairs (#756).
  [
    1,
    "retained-processes-hold:fingerprint-unreadable-denied denied=1",
    "retained incumbent the probe was not permitted to read a process fingerprint: fingerprint-unreadable-denied (1 denied read)",
  ],
  [
    1,
    "retained-processes-hold:unclassified-process denied=4",
    "retained incumbent a process it cannot classify is running: unclassified-process (4 denied reads)",
  ],
  // A count of zero is not something the probe says, and a receiver that accepted it would be
  // inventing a reading. Same for a field this receiver cannot parse, or one it was not given:
  // dropping part of an answer silently is how a receiver reports what the probe never said.
  [
    1,
    "retained-processes-hold:fingerprint-unreadable-denied denied=0",
    "retained incumbent process probe did not reach a verdict",
  ],
  [
    1,
    "retained-processes-hold:fingerprint-unreadable-denied comm=bun",
    "retained incumbent process probe did not reach a verdict",
  ],
  [
    1,
    "retained-processes-hold:fingerprint-unreadable-denied denied=1 pid=67",
    "retained incumbent process probe did not reach a verdict",
  ],
  [
    1,
    "retained-processes-hold:a-word-from-a-later-probe",
    "retained incumbent process probe answered a predicate this receiver does not know: a-word-from-a-later-probe",
  ],
] as const) {
  test(`both receivers report "${expected.slice(0, 48)}…"`, () => {
    expect(retainedProcessRefusal(code, output)).toBe(expected);
    expect(shellRefusal(code, output)).toBe(expected);
  });
}

/** The deploy path's own admission reader, called the way `require_retained_server_only` calls it. */
function shellAdmission(code: number, output: string): { admitted: boolean; denied: number } {
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      'here=$1; source "$here/common.sh"; source "$here/environment.sh"; retained_process_admission "$2" "$3"',
      "test",
      tooling,
      String(code),
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).toBe("");
  return {
    admitted: result.exitCode === 0,
    denied: result.exitCode === 0 ? Number(result.stdout.toString()) : 0,
  };
}

// What a SUCCESSFUL probe said, asked of both receivers independently. A denied read whose
// process the kernel then proved had exited is admitted (#762), and an admission that recorded
// nothing made that handling indistinguishable from a run where the condition never arose — so
// the count appears on a success too, bounded to the integer and silent at zero (#756). Anything
// that is not exactly one of those two shapes is not an admission, including a success token
// carrying a field a receiver cannot parse.
for (const [code, output, expected] of [
  [0, "retained-processes-server-only", { admitted: true, denied: 0 }],
  [0, "retained-processes-server-only denied=1", { admitted: true, denied: 1 }],
  [0, "retained-processes-server-only denied=12", { admitted: true, denied: 12 }],
  [0, "retained-processes-server-only denied=0", { admitted: false, denied: 0 }],
  [0, "retained-processes-server-only comm=bun", { admitted: false, denied: 0 }],
  [0, "retained-processes-server-only denied=1 pid=67", { admitted: false, denied: 0 }],
  [0, "retained-processes-hold:unclassified-process", { admitted: false, denied: 0 }],
  [1, "retained-processes-server-only", { admitted: false, denied: 0 }],
] as const) {
  test(`both receivers read "${output}" (exit ${code}) as ${expected.admitted ? `admitted with ${expected.denied}` : "not an admission"}`, () => {
    expect(retainedProcessAdmission(code, output)).toEqual(expected);
    expect(shellAdmission(code, output)).toEqual(expected);
  });
}

test("the vocabulary covers every predicate the classifier can answer with", () => {
  // The classifier's own closed `Hold` union, which is what the probe may print. A word the
  // probe can say and this file cannot explain is reported as unknown — diagnosable, but the
  // point of #738 is that it should not happen silently, so the two sets are pinned together.
  const predicates = [
    "server-process-shape",
    "server-process-absent",
    "server-restarted-during-probe",
    "zombie-identity-unconfirmed",
    "unclassified-process",
    "fingerprint-unreadable-denied",
    "fingerprint-unreadable-vanished",
    "fingerprint-unreadable-unmapped",
    "exit-unconfirmable-denied",
    "exit-unconfirmable-vanished",
    "exit-unconfirmable-unmapped",
    "exit-unproven",
    "pid-reused-during-probe",
    "proc-field-shape",
    "classifier-fault",
  ];
  const sentences = retainedProcessHoldSentences();
  expect(Object.keys(sentences).sort()).toEqual([...predicates].sort());
  for (const sentence of Object.values(sentences)) expect(sentence.length).toBeGreaterThan(8);
  // The shape `environment.sh` validates before it will use a predicate at all.
  for (const predicate of predicates) expect(predicate).toMatch(/^[a-z][a-z-]{0,46}[a-z]$/);
});
