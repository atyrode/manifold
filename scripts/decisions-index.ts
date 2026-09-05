#!/usr/bin/env bun
/**
 * THE DECISION RECORDS' INDEX, generated from the records themselves.
 *
 * A record in `docs/decisions/` is reasoning — alternatives, evidence, the yes or the no — and
 * is immutable once written; the living spec (`AXIOMS.md` §Change control) is the normative form
 * of every ratified decision. What a reader needs from the directory as a whole is therefore
 * only the status of each record, and that lives in one machine-readable block directly under
 * each title:
 *
 *   Date: YYYY-MM-DD
 *   Status: proposed | accepted | superseded | rejected
 *   Superseded-by: <filename>        only when Status is superseded
 *   Ratified: <free text>            optional
 *
 * `README.md` is this block, tabulated. It is never hand-edited: run
 * `bun scripts/decisions-index.ts` after touching a record, and `verify:axioms` S19 fails when
 * the file on disk is not what this module renders. The parser is exported for that check so
 * the gate and the generator can never disagree about what a well-formed block is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";

export const DECISIONS_DIR = "docs/decisions";
export const DECISIONS_INDEX = `${DECISIONS_DIR}/README.md`;
export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionRecord {
  readonly file: string;
  readonly title: string;
  readonly date: string;
  readonly status: DecisionStatus;
  readonly supersededBy: string | undefined;
  readonly ratified: string | undefined;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `00NN-slug.md`; the other naming scheme, `YYYY-MM-DD-slug.md`, has no number to collide on. */
const NUMBER_PREFIX = /^(\d{4})-(?!\d{2}-\d{2}-)/;
const TITLE_NUMBER = /^\d{4} [—-] /;

function isStatus(value: string): value is DecisionStatus {
  return (DECISION_STATUSES as readonly string[]).includes(value);
}

/** The record's status block, or the one sentence that says why it is not one. */
export function parseDecisionRecord(file: string, text: string): DecisionRecord | string {
  const lines = text.split("\n");
  const heading = lines[0] ?? "";
  if (!heading.startsWith("# ")) return `${file}: line 1 is not the title`;
  if (lines[1] !== "") return `${file}: line 2 must be blank`;
  const block: Record<string, string> = {};
  const order: string[] = [];
  let at = 2;
  for (; at < lines.length && lines[at] !== ""; at += 1) {
    const match = /^([A-Z][a-z-]+): (.*)$/.exec(lines[at] ?? "");
    if (match === null) return `${file}: line ${String(at + 1)} is not a "Field: value" line`;
    block[match[1]!] = match[2]!;
    order.push(match[1]!);
  }
  const expected = ["Date", "Status", "Superseded-by", "Ratified"].filter((field) =>
    Object.hasOwn(block, field),
  );
  if (order.join(",") !== expected.join(","))
    return `${file}: status block fields are ${order.join(", ")}; the order is Date, Status, Superseded-by, Ratified`;
  const date = block["Date"];
  if (date === undefined || !DATE_PATTERN.test(date))
    return `${file}: Date must be YYYY-MM-DD, got ${JSON.stringify(date)}`;
  const status = block["Status"];
  if (status === undefined || !isStatus(status))
    return `${file}: Status must be one of ${DECISION_STATUSES.join(" | ")}, got ${JSON.stringify(status)}`;
  const supersededBy = block["Superseded-by"];
  if (status === "superseded" && supersededBy === undefined)
    return `${file}: a superseded record names its successor in Superseded-by`;
  if (status !== "superseded" && supersededBy !== undefined)
    return `${file}: Superseded-by is only valid when Status is superseded`;
  return {
    file,
    title: heading.slice(2).replace(TITLE_NUMBER, ""),
    date,
    status,
    supersededBy,
    ratified: block["Ratified"],
  };
}

export interface DecisionRecords {
  readonly records: readonly DecisionRecord[];
  readonly problems: readonly string[];
}

/** Every record under `docs/decisions/`, sorted by date then filename, with every problem found. */
export function readDecisionRecords(repoRoot: string): DecisionRecords {
  const dir = join(repoRoot, DECISIONS_DIR);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
  const records: DecisionRecord[] = [];
  const problems: string[] = [];
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const parsed = parseDecisionRecord(file, readFileSync(join(dir, file), "utf8"));
    if (typeof parsed === "string") problems.push(parsed);
    else records.push(parsed);
    const number = NUMBER_PREFIX.exec(file)?.[1];
    if (number !== undefined) byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  const known = new Set(files);
  for (const record of records) {
    if (record.supersededBy !== undefined && !known.has(record.supersededBy))
      problems.push(
        `${record.file}: Superseded-by names ${record.supersededBy}, which does not exist`,
      );
  }
  for (const [number, owners] of byNumber) {
    if (owners.length > 1)
      problems.push(`record number ${number} is taken twice: ${owners.join(", ")}`);
  }
  records.sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
  return { records, problems };
}

/** The index as prettier leaves it, so `bun run format` and this generator agree byte-for-byte. */
export async function renderDecisionsIndex(
  repoRoot: string,
  records: readonly DecisionRecord[],
): Promise<string> {
  const rows = records.map(
    (r) =>
      `| [${r.file}](${r.file}) | ${r.date} | ${r.title.replaceAll("|", "\\|")} | ${r.status} | ${
        r.supersededBy === undefined ? "" : `[${r.supersededBy}](${r.supersededBy})`
      } |`,
  );
  const markdown = [
    "# Decision records",
    "",
    "Generated by `bun scripts/decisions-index.ts` from the status block under each record's title; `verify:axioms` S19 fails when this file drifts from the records, so it is never edited by hand.",
    "A record is the reasoning behind a ruling — alternatives, evidence, the yes or the no — and is immutable once written; the living spec (`AXIOMS.md`, `REGISTRY.md`, `docs/CONTRACTS.md`, `docs/PLUGINS.md`) is the normative form of every ratified decision and wins wherever a record disagrees (`AXIOMS.md` §Change control).",
    "",
    "| File | Date | Title | Status | Superseded by |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  const outputPath = join(repoRoot, DECISIONS_INDEX);
  return await format(markdown, { ...(await resolveConfig(outputPath)), parser: "markdown" });
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const { records, problems } = readDecisionRecords(repoRoot);
  for (const problem of problems) console.error(`decision record: ${problem}`);
  if (problems.length > 0) process.exit(1);
  await Bun.write(join(repoRoot, DECISIONS_INDEX), await renderDecisionsIndex(repoRoot, records));
  console.log(`Generated ${DECISIONS_INDEX} (${String(records.length)} records)`);
}
