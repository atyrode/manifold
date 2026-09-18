import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a retained-process probe's answer MEANS, for the two receivers that read it.
 *
 * The probe names every refusal it can reach (#699, #719, #741) and both receivers reported all
 * of them with one sentence about owning or unknown processes — true of exactly one predicate,
 * and a claim about a process table the probe may never have read (#738). The vocabulary is a
 * data file so the deploy path and this harness cannot drift into disagreeing about what a word
 * means; the classification below is the same decision in both, and its test asserts the two
 * agree string for string.
 */
export function retainedProcessHoldSentences(tooling: string): ReadonlyMap<string, string> {
  const rows = new Map<string, string>();
  for (const line of readFileSync(join(tooling, "retained-process-holds.tsv"), "utf8").split(
    "\n",
  )) {
    if (line.startsWith("#") || !line.includes("\t")) continue;
    const separator = line.indexOf("\t");
    rows.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return rows;
}

export function retainedProcessRefusal(code: number, output: string, tooling: string): string {
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
    retainedProcessHoldSentences(tooling).get(predicate) ??
    "process probe answered a predicate this receiver does not know";
  return `retained incumbent ${sentence}: ${predicate}`;
}
