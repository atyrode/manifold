/*
  The operator and deployment halves of a staged crossing (#1068). `stage` and `verify` run on
  the deployment host from the stable tooling checkout; `receive`, `journal` and `restore` run
  in a disposable, network-less container of the hub image against its stopped data volume.
  docs/SELF-HOST.md §Environments and infra/previews/README.md own the procedure.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginReplacementSetSchema } from "../packages/protocol/src/index.ts";
import {
  openDatabase,
  readReplacementDirectory,
  readReplacementJournal,
  receiveReplacementSet,
  restoreReplacements,
  ServerStore,
  stageReplacementSet,
} from "../packages/server/src/index.ts";

const USAGE = `usage:
  bun scripts/bundle-replacement.ts stage SET.json ROOT
  bun scripts/bundle-replacement.ts verify DIR SET_SHA256
  bun scripts/bundle-replacement.ts receive DIR SET_SHA256 REVISION DATA_DIR
  bun scripts/bundle-replacement.ts journal DATA_DIR
  bun scripts/bundle-replacement.ts restore DATA_DIR REVISION...`;

export async function main(argv: readonly string[]): Promise<string[]> {
  const [command, ...args] = argv;
  switch (command) {
    case "stage": {
      const [path, root] = args;
      if (!path || !root || args.length !== 2) break;
      const set = PluginReplacementSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      const { dir, setSha256 } = await stageReplacementSet(set, root);
      return [
        ...set.members.map(
          (member) =>
            `staged ${member.pluginId} ${member.sha256}${member.nativeReview ? " nativeReview" : ""}`,
        ),
        `staged set ${setSha256} at ${dir}`,
        setSha256,
      ];
    }
    case "verify": {
      const [dir, setSha256] = args;
      if (!dir || !setSha256 || args.length !== 2) break;
      const verified = await readReplacementDirectory(dir, setSha256);
      return [`verified set ${verified.setSha256}: ${String(verified.members.length)} bundle(s)`];
    }
    case "receive": {
      const [dir, setSha256, revision, dataDir] = args;
      if (!dir || !setSha256 || !revision || !dataDir || args.length !== 4) break;
      const verified = await receiveReplacementSet(dir, dataDir, setSha256, revision);
      return [`received set ${verified.setSha256} for ${revision}`];
    }
    case "journal": {
      const [dataDir] = args;
      if (!dataDir || args.length !== 1) break;
      return readReplacementJournal(dataDir)
        .map((record) => record.revision)
        .reverse();
    }
    case "restore": {
      const [dataDir, ...revisions] = args;
      if (!dataDir || revisions.length === 0) break;
      const store = new ServerStore(openDatabase(join(dataDir, "manifold.db")));
      try {
        return restoreReplacements(store, dataDir, revisions).map(
          (record) =>
            `restored ${record.revision}: ${record.members.map((member) => `${member.previous.pluginId}@${member.previous.sha256}`).join(", ")}; re-enabled ${String(record.disabledInstallations.length)} native installation(s)`,
        );
      } finally {
        store.close();
      }
    }
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  try {
    for (const line of await main(process.argv.slice(2))) console.log(line);
  } catch (error) {
    console.error(`bundle-replacement: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
