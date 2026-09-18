/**
 * WHAT EACH PREDICATE MEANS, for the two receivers that read a retained-process probe's answer.
 *
 * This lived in `infra/previews/retained-process-holds.tsv` and was read at runtime — and that
 * file is not in the installed-tooling list `verify-preview-environment.ts` copies, so every
 * lookup missed in the only environment that matters and every refusal reported "a predicate
 * this receiver does not know", including the one the vocabulary exists to explain. A meaning
 * whose delivery depends on a second list is absent exactly where it is needed, so each receiver
 * carries its own copy and the test asserts the two answer identically for every predicate.
 */
const SENTENCES: Readonly<Record<string, string>> = {
  "server-process-shape": "PID 1 is not the supported hub entrypoint",
  "server-process-absent": "no hub process is running at PID 1",
  "server-restarted-during-probe": "the hub restarted while the probe was reading it",
  "unclassified-process": "a process it cannot classify is running",
  "zombie-identity-unconfirmed":
    "a terminated process did not keep its identity while the probe confirmed it",
  "pid-reused-during-probe": "a PID was reused while the probe was reading it",
  "exit-unproven": "a process did not finish exiting within the probe's deadline",
  "fingerprint-unreadable-denied": "the probe was not permitted to read a process fingerprint",
  "fingerprint-unreadable-vanished":
    "the kernel disowned a task while the probe read its fingerprint",
  "fingerprint-unreadable-unmapped":
    "a process fingerprint read failed for a reason the probe does not map",
  "exit-unconfirmable-denied": "the probe was not permitted to confirm that a process had exited",
  "exit-unconfirmable-vanished": "the kernel disowned a task while the probe confirmed its exit",
  "exit-unconfirmable-unmapped":
    "confirming a process exit failed for a reason the probe does not map",
  "proc-field-shape": "a /proc field did not have the shape the probe requires",
  "classifier-fault":
    "the process classifier faulted, which is a defect in the probe and not a finding about this machine",
};

export function retainedProcessHoldSentences(): Readonly<Record<string, string>> {
  return SENTENCES;
}

export function retainedProcessRefusal(code: number, output: string): string {
  // 125 is docker's own failure, 126 not executable, 127 not found; no output at all with a
  // non-zero status is the same class — the probe's own first write never happened. None of
  // these is a finding about the process table, which is what reporting them as one was.
  if (code === 125 || code === 126 || code === 127 || (output === "" && code !== 0))
    return `retained incumbent process probe could not be run (exit ${code})`;
  const predicate = output.startsWith("retained-processes-hold:")
    ? output.slice("retained-processes-hold:".length)
    : "";
  if (!/^[a-z][a-z-]{0,46}[a-z]$/.test(predicate))
    // Un-inverted: a probe that never reached a verdict said "owning processes", and a probe
    // that ran and answered outside its vocabulary was reported as unavailable.
    return code === 0
      ? "retained incumbent process probe answered outside its vocabulary"
      : "retained incumbent process probe did not reach a verdict";
  const sentence =
    SENTENCES[predicate] ?? "process probe answered a predicate this receiver does not know";
  return `retained incumbent ${sentence}: ${predicate}`;
}
