import type { TerminalExitReason } from "@manifold/protocol";

/** Why the machine's terminal owner ended a terminal, in the exited tile's words (issue #853). */
export function terminalExitExplanation(reason: TerminalExitReason): string {
  switch (reason) {
    case "owner_stopped":
      return "Ended because this machine's terminal owner stopped.";
    case "owner_oom_stopped":
      return "Ended because this machine's terminal owner stopped after an out-of-memory kill.";
    case "owner_lost":
      return "Ended because this machine's terminal owner was replaced.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * The exited tile's status line, and one sentence more when the terminal's owner ended it. An
 * ordinary exit reads exactly as it always has.
 */
export function TerminalExitStatus({
  exitCode,
  exitReason,
}: {
  readonly exitCode: number | null;
  readonly exitReason: TerminalExitReason | null;
}) {
  return (
    <>
      {/*
        A null code is a shell that never reported one; "unknown" told the operator nothing the
        missing number did not already say.
      */}
      <span>{exitCode === null ? "exited" : `exited (${String(exitCode)})`}</span>
      {exitReason === null ? null : (
        <p className="terminal-exit-reason">{terminalExitExplanation(exitReason)}</p>
      )}
    </>
  );
}
