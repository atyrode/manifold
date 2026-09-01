/**
 * manifold trace gate — axiom A6 made falsifiable.
 *
 * A6 says every exercise of authority leaves a trace. That is a claim about the DISPATCH
 * LADDER, so this gate holds the ladder to it from both ends, and the split is the same one
 * `verify:axioms` uses: what can be proved about the SOURCE is proved with the TypeScript
 * parser, and what can only be proved about a RUNNING workspace is proved against a real
 * composed server.
 *
 *   T1 the ledger has exactly one writer, and it is the ladder
 *   T2 every traced rung is constructed in ONE place, and the untraced one is the ruled-out one
 *   T3 every registered door, dispatched, leaves a trace row naming it — a door without one is RED
 *   T4 the outcome is the ladder's own word: `ok` with the nodes the door named, and each rung
 *   T5 the one name that leaves no row leaves a log line instead
 *
 * T1 and T2 are the STATIC half, and they are what makes coverage a property of construction
 * rather than of this gate's imagination: a rung that refuses without going through the one
 * constructor fails T2 whether or not anybody remembers to dispatch it here. T3 is the dynamic
 * half, and it needs no per-door fixture — every door's input is a `z.strictObject`, so one
 * sentinel argument refuses at the argument rung and every door can be knocked on safely.
 *
 * Self-contained: spawns its own server on an ephemeral port with its own data dir, reads the
 * roster it is about to exercise from that server, and cleans up. No browser, no bundle.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  ActionOutcomeSchema,
  PluginsResponseSchema,
  TRACE_OUTCOMES,
  TRACED_DENIAL_RULES,
  UNTRACED_DENIAL_RULE,
  type LogEvent,
} from "../packages/protocol/src/index.ts";
import { EventsListResponseSchema, type EventRow } from "../packages/plugins/events/src/index.ts";
import { TRACE_ROW_TYPE } from "../packages/server/src/stores.ts";

const repoRoot = join(import.meta.dir, "..");
const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

const list = (values: readonly string[]): string => values.slice().sort().join(", ");

// ═══════════════════════════════════════════════════════════ the static half

const LADDER_FILE = "packages/server/src/plugin-host.ts";
const STORE_FILE = "packages/server/src/stores.ts";
const LEDGER_METHODS: Record<string, true> = { appendTrace: true, settleTrace: true };

function parsed(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(repoRoot, path), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
}

const serverSources = [...new Bun.Glob("packages/server/src/**/*.ts").scanSync(repoRoot)].sort();

/**
 * T1 — WHO MAY WRITE THE LEDGER. One store door, one caller, and the caller is the ladder.
 *
 * The value of this check is not tidiness: a trace written from anywhere else would be an
 * attribution nobody's dispatch stands behind, and a ledger with two writers is a ledger whose
 * completeness is an intersection of two disciplines instead of a property of one function.
 */
{
  const callers: string[] = [];
  for (const path of serverSources) {
    const file = parsed(path);
    let calls = 0;
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        LEDGER_METHODS[node.expression.name.text] === true
      ) {
        calls += 1;
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(file, walk);
    if (calls > 0) callers.push(path);
  }
  const expected = [LADDER_FILE, STORE_FILE].sort();
  const unexpected = callers.filter((path) => path !== LADDER_FILE && path !== STORE_FILE);
  check(
    "T1 one ledger writer",
    unexpected.length === 0 && callers.includes(LADDER_FILE),
    unexpected.length === 0 && callers.includes(LADDER_FILE)
      ? `appendTrace/settleTrace are called only from ${list(expected)}`
      : `the trace ledger is written outside the dispatch ladder: ${list(unexpected)}`,
  );
}

/**
 * T2 — EVERY TRACED RUNG, BY CONSTRUCTION.
 *
 * The ladder's `run` is walked for every object literal that denies (`ok: false`). There must be
 * exactly two: the one inside the refusal constructor — which appends the row — and the
 * `unknown_action` rung, which ADR 0018 §4 rules out of the ledger by argument. A new rung that
 * returned its own denial literal would be an untraced refusal, and it fails HERE rather than
 * whenever somebody next thinks to dispatch it.
 */
{
  const file = parsed(LADDER_FILE);
  let run: ts.MethodDeclaration | null = null;
  const findRun = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === "run") run = node;
    ts.forEachChild(node, findRun);
  };
  ts.forEachChild(file, findRun);

  if (run === null) {
    check("T2 traced rungs", false, `${LADDER_FILE} has no \`run\` method to walk`);
  } else {
    interface Denial {
      readonly rule: string | null;
      readonly appends: boolean;
    }
    const denials: Denial[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const ok = node.properties.find(
          (property) => ts.isPropertyAssignment(property) && property.name.getText(file) === "ok",
        );
        if (
          ok !== undefined &&
          ts.isPropertyAssignment(ok) &&
          ok.initializer.kind === ts.SyntaxKind.FalseKeyword
        ) {
          const denial = node.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) && property.name.getText(file) === "denial",
          );
          let rule: string | null = null;
          if (denial !== undefined && ts.isPropertyAssignment(denial)) {
            const shape = denial.initializer;
            if (ts.isObjectLiteralExpression(shape)) {
              for (const property of shape.properties) {
                if (!ts.isPropertyAssignment(property)) continue;
                if (property.name.getText(file) !== "rule") continue;
                rule = ts.isStringLiteralLike(property.initializer)
                  ? property.initializer.text
                  : null;
              }
            }
          }
          /*
            "Is this denial recorded?" is asked of the STATEMENT BLOCK the denial lives in, and
            that is the honest granularity: a rung that refuses records its row in the same
            breath, so the write and the refusal are neighbours by construction. Asking the
            whole method would answer yes for every literal in it, which is how a check comes
            to bless the very thing it exists to catch.
           */
          let block: ts.Node = node;
          while (block.parent !== undefined && !ts.isBlock(block)) block = block.parent;
          const text = block.getText(file);
          denials.push({
            rule,
            appends: text.includes(".appendTrace(") || text.includes(".settleTrace("),
          });
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(run, walk);

    const untraced = denials.filter((denial) => !denial.appends);
    const traced = denials.filter((denial) => denial.appends);
    const exempt =
      untraced.length === 1 && untraced[0]?.rule === UNTRACED_DENIAL_RULE ? untraced[0] : null;
    const ok = traced.length > 0 && exempt !== null;
    check(
      "T2 traced rungs",
      ok,
      ok
        ? `the ladder denies in ${String(denials.length)} places: ${String(traced.length)} write the ledger in the same block, and the one that does not is \`${UNTRACED_DENIAL_RULE}\`, exempt by ruling (ADR 0018 §4)`
        : `the ladder's refusals are not all recorded: ${String(traced.length)} traced, ${String(untraced.length)} untraced (${list(untraced.map((denial) => denial.rule ?? "unnamed"))}). A rung that refuses without writing a trace violates A6.`,
    );
  }
}

/** The vocabulary join, asserted where both halves are readable at once. */
{
  const words: readonly string[] = TRACE_OUTCOMES;
  const missing = TRACED_DENIAL_RULES.filter((rule) => !words.includes(rule));
  check(
    "T2 outcome vocabulary",
    missing.length === 0 && !words.includes(UNTRACED_DENIAL_RULE),
    missing.length === 0
      ? `every denial rung but \`${UNTRACED_DENIAL_RULE}\` is an outcome the ledger can write (${list(words)})`
      : `the ledger cannot record these rungs: ${list(missing)}`,
  );
}

// ═══════════════════════════════════════════════════════════ the live half

const dataDir = mkdtempSync(join(tmpdir(), "manifold-trace-data-"));
const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: "0",
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_SPAWN_AGENT: "0",
  },
  // Piped, never echoed: the boot line can carry the owner key (invariant 6). The stream is
  // read for the origin and for the one-line-per-dispatch action log, which is where T5's
  // untraced name has to remain visible.
  stdout: "pipe",
  stderr: "inherit",
});

const ACTION_EVT: LogEvent = "action";
const actionLog: { readonly name: string; readonly outcome: string }[] = [];
let origin = "";

async function consumeServerLog(): Promise<void> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const readyUrl = /manifold ready url=(https?:\/\/[^\s"']+)/.exec(line)?.[1];
      if (readyUrl !== undefined && origin === "") origin = new URL(readyUrl).origin;
      if (!line.startsWith("{")) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (Reflect.get(record as object, "evt") !== ACTION_EVT) continue;
        actionLog.push({
          name: String(Reflect.get(record as object, "name")),
          outcome: String(Reflect.get(record as object, "outcome")),
        });
      } catch {
        // Boot chrome; this gate reads only the structured stream.
      }
    }
  }
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function stopServer(): Promise<void> {
  if (server.exitCode === null) server.kill("SIGTERM");
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stopped && server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
}

/**
 * READ VERBS, so the report can say how many of the doors it exercised were mutating ones.
 *
 * The classification errs toward "mutating": a door is a read only if its own verb says so,
 * which is the same shape as S10's closed removal-verb list. It never changes what is
 * asserted — T3 demands a trace from EVERY door, mutating or not — it changes only what the
 * gate can honestly claim in one line.
 */
const READ_VERBS: readonly string[] = ["read", "list", "get", "resolve", "describe"];

try {
  void consumeServerLog().catch(() => {
    // The stream ends when the server does; a torn read is not a gate result.
  });
  await until(() => origin !== "", "the server's ready line");
  await until(async () => {
    try {
      return (await fetch(`${origin}/healthz`)).ok;
    } catch {
      return false;
    }
  }, "the server's healthz");

  const ownerKey = (await Bun.file(join(dataDir, "owner.key")).text()).trim();
  const dispatch = async (name: string, args: unknown, token = ownerKey): Promise<unknown> =>
    await (
      await fetch(`${origin}/api/actions/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      })
    ).json();

  /** The ledger, read through the ONE door that reads the trail. */
  const ledger = async (): Promise<readonly EventRow[]> => {
    const outcome = ActionOutcomeSchema.parse(
      await dispatch("core.events.list", { kind: TRACE_ROW_TYPE, limit: 500 }),
    );
    if (!outcome.ok) throw new Error(`the trail refused the gate: ${outcome.denial.message}`);
    return EventsListResponseSchema.parse(outcome.result).events;
  };

  /*
    THE ROSTER THIS GATE EXERCISES comes from the server it is about to knock on, not from a
    list in this file: an action that exists only in the assembly is exactly the action a
    hand-written list would miss (A1, D10).
   */
  const roster = PluginsResponseSchema.parse(
    await (
      await fetch(`${origin}/api/plugins`, { headers: { authorization: `Bearer ${ownerKey}` } })
    ).json(),
  ).plugins;
  const doors: { readonly name: string; readonly mutating: boolean }[] = [];
  for (const entry of roster) {
    for (const action of entry.actions) {
      const local = action.name.slice(action.name.lastIndexOf(".") + 1).toLowerCase();
      doors.push({
        name: action.name,
        mutating: !READ_VERBS.some((verb) => local.startsWith(verb)),
      });
    }
  }

  /*
    T3 — KNOCK ON EVERY DOOR. The sentinel is an argument no door declares, and every door's
    input is a `z.strictObject`, so each dispatch refuses at the ARGUMENT rung: nothing is
    created, nothing is destroyed, every door is exercised, and the ledger is asked whether it
    noticed. A door that answers something other than `invalid_args` is reported rather than
    failed — the assertion is about the TRACE, not about which rung answered.
   */
  const SENTINEL = { __trace_gate__: true };
  const answers: Record<string, string> = {};
  for (const door of doors) {
    const outcome = ActionOutcomeSchema.parse(await dispatch(door.name, SENTINEL));
    answers[door.name] = outcome.ok ? "ok" : outcome.denial.rule;
  }
  const knocked = await ledger();
  const traced: Record<string, true> = {};
  for (const row of knocked) if (row.door !== null) traced[row.door] = true;
  const untraced = doors.filter((door) => traced[door.name] !== true);
  const mutating = doors.filter((door) => door.mutating);
  check(
    "T3 every door traces",
    untraced.length === 0,
    untraced.length === 0
      ? `${String(doors.length)} registered doors dispatched (${String(mutating.length)} mutating), every one of them in the ledger`
      : `these registered doors left NO trace row: ${list(untraced.map((door) => door.name))}`,
  );
  /*
    THE WRITE-AHEAD, OBSERVED IN PRODUCTION. Exactly one row may be unsettled, and it must be
    the reading door's OWN: `core.events.list` sees its trace already in the journal while its
    handler is still running, because the ladder committed the attribution before invoking it.
    Any OTHER unsettled row would mean a dispatch that never came back — which is precisely
    what an unsettled row is for, and never something a finished gate run should contain.
   */
  const inFlight = knocked.filter((row) => row.outcome === null);
  const onlyTheReader = inFlight.length === 1 && inFlight[0]?.door === "core.events.list";
  check(
    "T3 the attribution precedes the outcome",
    onlyTheReader,
    onlyTheReader
      ? `${String(knocked.length - 1)} rows settled, and the one that is not is the reading door's own dispatch — the attribution is durable before its handler runs`
      : `${String(inFlight.length)} unsettled row(s): ${list(inFlight.map((row) => row.door ?? "unnamed"))}`,
  );

  /*
    T4 — THE OK PATH, AND THE RUNGS. One real mutating dispatch, so the ledger is proved to
    record a COMMIT and the nodes the door named, and one attenuated credential, so it is
    proved to record a refusal against the authority that failed.
   */
  const created = ActionOutcomeSchema.parse(
    await dispatch("core.index.createContainer", { name: `trace-gate-${Date.now().toString(36)}` }),
  );
  if (!created.ok)
    throw new Error(`the gate's own container was refused: ${created.denial.message}`);
  const afterCommit = await ledger();
  const commit = afterCommit.find(
    (row) => row.door === "core.index.createContainer" && row.outcome === "ok",
  );
  check(
    "T4 a commit is attributed",
    commit !== undefined && commit.targets.length > 0 && commit.authority !== null,
    commit === undefined
      ? "a committed mutation left no `ok` trace row"
      : `the commit is attributed: actor=${String(commit.principalId)} authority=${String(commit.authority)} targets=${list(commit.targets)}`,
  );

  const grant = ActionOutcomeSchema.parse(
    await dispatch("core.access.mint", {
      principal: { name: "trace-gate", kind: "agent" },
      caps: ["containers:read"],
    }),
  );
  if (!grant.ok) throw new Error(`the gate could not mint: ${grant.denial.message}`);
  const guestToken = String(Reflect.get(grant.result as object, "token"));
  const refused = ActionOutcomeSchema.parse(
    await dispatch("core.index.createContainer", { name: "not-allowed" }, guestToken),
  );
  const afterRefusal = await ledger();
  const refusal = afterRefusal.find(
    (row) => row.door === "core.index.createContainer" && row.outcome === "forbidden",
  );
  check(
    "T4 a refusal is attributed",
    !refused.ok && refusal !== undefined,
    refusal === undefined
      ? "a refused dispatch left no trace row naming its rung"
      : `the refusal is attributed: actor=${String(refusal.principalId)} authority=${String(refusal.authority)} outcome=${String(refusal.outcome)}`,
  );

  /*
    T5 — THE ONE EXEMPTION, both halves. An unregistered name writes no row, because there is
    no door and no authority to attribute; and it is still visible, because the ladder's log
    line is where the self-description obligation puts every dispatch.
   */
  const unknownName = "core.nothing.here";
  const unknown = ActionOutcomeSchema.parse(await dispatch(unknownName, {}));
  const afterUnknown = await ledger();
  const leaked = afterUnknown.filter((row) => row.door === unknownName);
  await until(
    () => actionLog.some((line) => line.name === unknownName),
    "the unknown action's log line",
  );
  const logged = actionLog.find((line) => line.name === unknownName);
  check(
    "T5 the untraced name is logged instead",
    !unknown.ok &&
      !unknown.ok &&
      unknown.denial.rule === UNTRACED_DENIAL_RULE &&
      leaked.length === 0 &&
      logged?.outcome === UNTRACED_DENIAL_RULE,
    leaked.length > 0
      ? `an unregistered name wrote ${String(leaked.length)} ledger row(s); the ledger's \`door\` column is now caller-chosen`
      : `\`${unknownName}\` left no row and one \`${ACTION_EVT}\` log line at outcome=${String(logged?.outcome)}`,
  );

  const outcomes: Record<string, number> = {};
  for (const row of afterUnknown) {
    const word = row.outcome ?? "unsettled";
    outcomes[word] = (outcomes[word] ?? 0) + 1;
  }
  console.log(
    `\nledger: ${String(afterUnknown.length)} rows — ${Object.entries(outcomes)
      .map(([word, count]) => `${word}:${String(count)}`)
      .sort()
      .join(" ")}`,
  );
  console.log(
    `rungs answered while knocking: ${list(
      [...new Set(Object.values(answers))].map((rung) => rung),
    )}`,
  );
} catch (error) {
  check("trace gate", false, error instanceof Error ? error.message : String(error));
} finally {
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\nverify:trace GREEN"
    : `\nverify:trace RED\n${failures.map((failure) => ` - ${failure}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
