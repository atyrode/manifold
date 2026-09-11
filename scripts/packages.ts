/**
 * The workspace projects the gate typechecks and tests.
 *
 * One list, three readers: `scripts/gate.ts` schedules a `tsc` per entry, its unit-test task
 * passes them to one `bun test`, and CI shards that same set across runners. A package added
 * to the workspace and not to this list is a package nothing typechecks, so the list lives
 * here rather than inside whichever runner happened to need it first.
 *
 * Order is the dependency-ish order the gate has always used — protocol first, the leaf
 * plugins last — because a failing typecheck deep in the graph reads better after the root
 * it depends on has already reported.
 */
export const typecheckProjects = [
  "protocol",
  "ui",
  "plugin",
  "scene",
  "sdk",
  "server",
  "agent",
  "testkit",
  "web",
  "plugins/shell",
  "plugins/plugin-manager",
  "plugins/terminals",
  "plugins/presence",
  "plugins/machines",
  "plugins/index",
  "plugins/notes",
  "plugins/uri",
  "plugins/access",
  "plugins/events",
  "plugins/debug",
  "plugins/brand",
  "plugins/keys",
  "plugins/canvas",
  "plugins/compositions",
  "plugins/arrange",
  "plugins/commands",
] as const satisfies readonly string[];

/**
 * The projects the unit-test task runs. testkit is excluded because its suite IS the e2e
 * task: it boots real servers and browsers and needs the longer timeout, so running it here
 * too would pay for the slowest suite in the repo twice.
 */
export const unitTestProjects: readonly string[] = typecheckProjects.filter(
  (name) => name !== "testkit",
);

/** `packages/<name>` for each project, the form both `tsc -p` and `bun test` take. */
export function projectDirs(projects: readonly string[]): readonly string[] {
  return projects.map((name) => `packages/${name}`);
}

// Printing form, so a shell or a workflow can consume the same list without re-typing it.
if (import.meta.main) {
  const which = process.argv[2] ?? "--typecheck";
  const selected =
    which === "--unit"
      ? projectDirs(unitTestProjects)
      : which === "--typecheck"
        ? projectDirs(typecheckProjects)
        : null;
  if (selected === null) {
    console.error("usage: bun scripts/packages.ts [--typecheck|--unit]");
    process.exit(2);
  }
  console.log(selected.join("\n"));
}
