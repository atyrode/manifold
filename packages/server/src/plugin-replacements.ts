import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ActionSummarySchema,
  AuthoredCapSchema,
  canonicalJobJson,
  HARDENED_CONTRACT_COMPAT_VERSIONS,
  PluginInstallModeSchema,
  PluginReplacementSetSchema,
  type PluginBundle,
  type PluginDataVersion,
  type PluginReplacementMember,
  type PluginReplacementSet,
} from "@manifold/protocol";
import { CredentialReferenceSchema } from "./authority-snapshot.ts";
import { inspectArtifact, removeInstall, type VerifiedPluginArtifact } from "./plugin-installs.ts";
import { covers, pluginBuildCompatibility } from "./plugin-updates.ts";
import { sha256Hex, type PluginInstallRow, type ServerStore } from "./stores.ts";

/*
  A STAGED CROSSING (#1068). When a new hub would hold the installed closure as
  `repack_required`, the deployment stages whole replacement bundles for the same plugin ids and
  the candidate hub installs them through the one installer at boot, before it serves and before
  native execution observes a hold. Everything here is the file format and the rules around that
  installation: the staged directory, the per-member admission rules, and the journal that lets
  the deployment restore the previous bundles with the previous hub.

  Layout under the data directory:
    plugin-replacement/staged/set.json                       canonical replacement set
    plugin-replacement/staged/revision                       deploying commit, receipt only
    plugin-replacement/staged/<sha256>.manifold-plugin.json  each member's exact bytes
    plugin-replacement/journal.json                          applied crossings, oldest first
*/

export const PLUGIN_REPLACEMENT_DIR = "plugin-replacement";
const SET_FILE = "set.json";
const REVISION_FILE = "revision";
const BUNDLE_SUFFIX = ".manifold-plugin.json";
const JOURNAL_FILE = "journal.json";
const REVISION = /^[0-9a-f]{40}$/;
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** A replacement set's identity: the sha256 of its canonical JSON. */
export function replacementSetSha256(set: PluginReplacementSet): string {
  return sha256Hex(canonicalJobJson(PluginReplacementSetSchema.parse(set)));
}

export function stagedReplacementDir(dataDir: string): string {
  return join(dataDir, PLUGIN_REPLACEMENT_DIR, "staged");
}

export interface VerifiedReplacementSet {
  readonly set: PluginReplacementSet;
  readonly setSha256: string;
  readonly members: readonly {
    readonly member: PluginReplacementMember;
    readonly artifact: VerifiedPluginArtifact;
  }[];
}

/** One member, verified by the same reader, pin and bundle checks as the install door. */
async function verifiedMember(
  member: PluginReplacementMember,
  source: string,
  dataDir: string,
  signal?: AbortSignal,
): Promise<VerifiedPluginArtifact> {
  const artifact = await inspectArtifact({
    source,
    sha256: member.sha256,
    dataDir,
    devPaths: true,
    ...(signal === undefined ? {} : { signal }),
  });
  if (artifact.bundle.manifest.id !== member.pluginId)
    throw new Error(
      `${member.pluginId}: replacement bundle names "${artifact.bundle.manifest.id}", not its plugin id`,
    );
  return artifact;
}

/**
 * Reads a staged directory exactly: a canonical `set.json`, every member's pinned bytes and
 * nothing else (an optional `revision` receipt aside). Any extra, missing or mismatched file
 * refuses the whole set; a set is never partially staged.
 */
export async function readReplacementDirectory(
  dir: string,
  expectedSha256?: string,
): Promise<VerifiedReplacementSet> {
  const text = readFileSync(join(dir, SET_FILE), "utf8");
  const set = PluginReplacementSetSchema.parse(JSON.parse(text));
  if (text !== canonicalJobJson(set)) throw new Error("replacement set.json is not canonical JSON");
  const setSha256 = sha256Hex(text);
  if (expectedSha256 !== undefined && setSha256 !== expectedSha256)
    throw new Error(`replacement set hashes to ${setSha256}, not ${expectedSha256}`);
  const expected = new Set([SET_FILE, ...set.members.map(({ sha256 }) => sha256 + BUNDLE_SUFFIX)]);
  for (const name of readdirSync(dir)) {
    if (!expected.has(name) && name !== REVISION_FILE)
      throw new Error(`replacement directory holds an unexpected entry "${name}"`);
  }
  const members = [];
  for (const member of set.members)
    members.push({
      member,
      artifact: await verifiedMember(member, join(dir, member.sha256 + BUNDLE_SUFFIX), dir),
    });
  return { set, setSha256, members };
}

/**
 * The operator's staging step: fetch every member over HTTPS, verify its pin and bundle, and
 * write `<root>/<set sha256>/`. Nothing is installed; the deployment names the set by digest.
 */
export async function stageReplacementSet(
  set: PluginReplacementSet,
  root: string,
  signal?: AbortSignal,
): Promise<{ readonly dir: string; readonly setSha256: string }> {
  const parsed = PluginReplacementSetSchema.parse(set);
  const setSha256 = replacementSetSha256(parsed);
  const dir = join(root, setSha256);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(dir)) {
    await readReplacementDirectory(dir, setSha256);
    return { dir, setSha256 };
  }
  const incoming = mkdtempSync(join(root, ".staging-"));
  try {
    for (const member of parsed.members) {
      const artifact = await verifiedMember(member, member.url, incoming, signal);
      writeFileSync(join(incoming, member.sha256 + BUNDLE_SUFFIX), artifact.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    writeFileSync(join(incoming, SET_FILE), canonicalJobJson(parsed), { flag: "wx", mode: 0o600 });
    await readReplacementDirectory(incoming, setSha256);
    renameSync(incoming, dir);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  return { dir, setSha256 };
}

/**
 * The deployment's hand-off into the stopped hub's data directory: re-verify the staged set by
 * digest, then replace any previously staged set whole. `revision` is the deploying commit.
 */
export async function receiveReplacementSet(
  source: string,
  dataDir: string,
  setSha256: string,
  revision: string,
): Promise<VerifiedReplacementSet> {
  if (!REVISION.test(revision)) throw new Error("replacement revision must be a full commit SHA");
  const verified = await readReplacementDirectory(source, setSha256);
  const staged = stagedReplacementDir(dataDir);
  mkdirSync(join(dataDir, PLUGIN_REPLACEMENT_DIR), { recursive: true, mode: 0o700 });
  const incoming = mkdtempSync(join(dataDir, PLUGIN_REPLACEMENT_DIR, ".incoming-"));
  try {
    for (const name of [SET_FILE, ...verified.set.members.map((m) => m.sha256 + BUNDLE_SUFFIX)])
      copyFileSync(join(source, name), join(incoming, name));
    writeFileSync(join(incoming, REVISION_FILE), revision, { mode: 0o600 });
    await readReplacementDirectory(incoming, setSha256);
    rmSync(staged, { recursive: true, force: true });
    renameSync(incoming, staged);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  return verified;
}

export function clearStagedReplacement(dataDir: string): void {
  rmSync(stagedReplacementDir(dataDir), { recursive: true, force: true });
}

export interface StagedReplacement extends VerifiedReplacementSet {
  readonly revision: string;
}

/** The set a stopped deployment handed this hub, or null when none is staged. */
export async function loadStagedReplacement(dataDir: string): Promise<StagedReplacement | null> {
  const dir = stagedReplacementDir(dataDir);
  if (!existsSync(dir)) return null;
  const revision = readFileSync(join(dir, REVISION_FILE), "utf8");
  if (!REVISION.test(revision)) throw new Error("staged replacement revision is malformed");
  return { ...(await readReplacementDirectory(dir)), revision };
}

/** What the rules read of an installation: its packing mode and its verified bundle. */
export interface ReplacementIncumbent {
  readonly row: { readonly mode?: PluginInstallRow["mode"] | undefined };
  readonly bundle: PluginBundle | null;
}

/**
 * Why one member may not cross, or nothing. A crossing replaces bytes and keeps everything the
 * installation already holds: the row's grants and installer lineage, its data major, and its
 * native consents unless the operator acknowledged that the native declaration changes. Wider
 * capability ceilings, data migrations and unknown or incompatible builds are not crossings.
 */
export function replacementRefusals(
  member: PluginReplacementMember,
  candidate: PluginBundle,
  incumbent: ReplacementIncumbent | undefined,
  storedDataVersion: PluginDataVersion | null,
): string[] {
  const id = member.pluginId;
  if (incumbent === undefined)
    return [`${id}: not installed; a crossing only replaces installed plugins`];
  const refusals: string[] = [];
  if (candidate.manifest.id !== id) refusals.push(`${id}: bundle names "${candidate.manifest.id}"`);
  if (incumbent.row.mode === "unpacked")
    refusals.push(`${id}: built from this instance's authored directory, which alone updates it`);
  if (incumbent.bundle === null) {
    refusals.push(`${id}: the installed bundle is unverified; repair it before a crossing`);
    return refusals;
  }
  const compatibility = pluginBuildCompatibility(candidate);
  if (compatibility.status !== "compatible")
    refusals.push(
      `${id}: repack_required; ${
        compatibility.issues
          .map(
            (issue) =>
              `${issue.component} built against ${issue.built ?? "an unrecorded version"} (${issue.kind}), this server runs ${issue.current}`,
          )
          .join("; ") || "build metadata incomplete"
      }`,
    );
  if (
    candidate.hardenedContract === undefined ||
    !HARDENED_CONTRACT_COMPAT_VERSIONS.has(candidate.hardenedContract)
  )
    refusals.push(
      `${id}: repack_required; hardened contract ${String(candidate.hardenedContract)} is not accepted`,
    );
  const before = incumbent.bundle.manifest.capabilities;
  const added = [...new Set(candidate.manifest.capabilities.filter((cap) => !covers(before, cap)))];
  if (added.length > 0)
    refusals.push(
      `${id}: consent_required; the replacement widens the capability ceiling (${added.join(", ")}); cross without it and use the reviewed update`,
    );
  const declared = candidate.manifest.dataVersion;
  const previous = incumbent.bundle.manifest.dataVersion;
  if (
    declared !== undefined &&
    ((previous !== undefined && previous.major !== declared.major) ||
      (storedDataVersion !== null && storedDataVersion.major !== declared.major))
  )
    refusals.push(
      `${id}: data_major_changed; a crossing keeps the data major (installed ${String(previous?.major ?? storedDataVersion?.major)}, replacement ${String(declared.major)}) so the previous bundle can read it after rollback`,
    );
  const changed =
    canonicalJobJson(incumbent.bundle.manifest.machine ?? null) !==
    canonicalJobJson(candidate.manifest.machine ?? null);
  if (changed && member.nativeReview !== true)
    refusals.push(
      `${id}: native declaration changed; set nativeReview to disable its native installations until the deployment review admits the new declaration`,
    );
  if (!changed && member.nativeReview === true)
    refusals.push(`${id}: nativeReview is set but the native declaration is unchanged`);
  return refusals;
}

const InstallRowSchema = z
  .strictObject({
    pluginId: z.string().min(1),
    sha256: hash,
    source: z.string(),
    grantedCaps: AuthoredCapSchema.array(),
    installedBy: z.string().min(1),
    installedAt: z.number().int().nonnegative(),
    bundlePath: z.string().min(1),
    actions: ActionSummarySchema.array(),
    hardened: z.boolean().optional(),
    builtAgainst: z.record(z.string(), z.string()).optional(),
    mode: PluginInstallModeSchema.optional(),
    installer: CredentialReferenceSchema.optional(),
  })
  // Rebuild the row without absent keys: the store writes it back whole on restore.
  .transform(({ hardened, builtAgainst, mode, installer, ...row }): PluginInstallRow => ({
    ...row,
    ...(hardened === undefined ? {} : { hardened }),
    ...(builtAgainst === undefined ? {} : { builtAgainst }),
    ...(mode === undefined ? {} : { mode }),
    ...(installer === undefined ? {} : { installer }),
  }));

const NativeInstallationSchema = z.strictObject({
  machineId: z.string().min(1),
  pluginId: z.string().min(1),
  revision: z.string().min(1),
  artifact: hash,
});
export type ReplacedNativeInstallation = z.infer<typeof NativeInstallationSchema>;

const ReplacementRecordSchema = z.strictObject({
  format: z.literal(1),
  setSha256: hash,
  revision: z.string().regex(REVISION),
  appliedAt: z.number().int().nonnegative(),
  members: z
    .array(z.strictObject({ sha256: hash, previous: InstallRowSchema, nativeReview: z.boolean() }))
    .min(1),
  /** Enabled native installations the crossing disabled, recorded before it disabled them. */
  disabledInstallations: NativeInstallationSchema.array(),
});
export type ReplacementRecord = z.infer<typeof ReplacementRecordSchema>;
const JournalSchema = ReplacementRecordSchema.array();

export function readReplacementJournal(dataDir: string): ReplacementRecord[] {
  const path = join(dataDir, PLUGIN_REPLACEMENT_DIR, JOURNAL_FILE);
  if (!existsSync(path)) return [];
  return JournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Atomic: a crash leaves either the previous journal or this one. */
export function writeReplacementJournal(
  dataDir: string,
  records: readonly ReplacementRecord[],
): void {
  const path = join(dataDir, PLUGIN_REPLACEMENT_DIR, JOURNAL_FILE);
  const parsed = JournalSchema.parse(records);
  if (parsed.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(dataDir, PLUGIN_REPLACEMENT_DIR), { recursive: true, mode: 0o700 });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

/**
 * THE ROLLBACK HALF. Restores the newest journal records, newest first and named exactly, so the
 * previous hub boots its previous bundles: each row goes back to its recorded previous row, and
 * each native installation the crossing disabled is re-enabled at the same revision and artifact,
 * the approval it held before. A row that is already the previous one was never committed. Any
 * other row, or an installation that moved since, refuses the whole restore: its change was not
 * this crossing's, and restoring over it would discard a later decision.
 */
export function restoreReplacements(
  store: ServerStore,
  dataDir: string,
  revisions: readonly string[],
): ReplacementRecord[] {
  const journal = readReplacementJournal(dataDir);
  const newest = journal.slice(journal.length - revisions.length).reverse();
  if (
    revisions.length === 0 ||
    revisions.length > journal.length ||
    newest.some((record, index) => record.revision !== revisions[index])
  )
    throw new Error(
      `restore must name the newest crossings newest first; journal holds ${journal.map((record) => record.revision).join(", ") || "none"}`,
    );
  const removed: string[] = [];
  store.transaction(() => {
    const reenable = store.db.query<void, [string, string, string, string]>(
      "UPDATE machine_job_installs SET enabled=1, ready=0 WHERE machine_id=? AND plugin_id=? AND revision=? AND artifact=? AND enabled=0 AND purge_requested=0",
    );
    const current = store.db.query<
      { revision: string; artifact: string; enabled: number; purge_requested: number },
      [string, string]
    >(
      "SELECT revision, artifact, enabled, purge_requested FROM machine_job_installs WHERE machine_id=? AND plugin_id=?",
    );
    for (const record of newest) {
      const rows = new Map(store.pluginInstalls().map((row) => [row.pluginId, row]));
      for (const member of record.members) {
        const row = rows.get(member.previous.pluginId);
        if (row?.sha256 === member.previous.sha256) continue;
        if (row?.sha256 !== member.sha256)
          throw new Error(
            `${member.previous.pluginId}: installed ${row?.sha256 ?? "nothing"}, not the crossing's ${member.sha256}; restore refused`,
          );
        store.putPluginInstall(member.previous);
        removed.push(row.bundlePath);
      }
      for (const installation of record.disabledInstallations) {
        const now = current.get(installation.machineId, installation.pluginId);
        if (
          now === null ||
          now.revision !== installation.revision ||
          now.artifact !== installation.artifact ||
          now.purge_requested !== 0
        )
          throw new Error(
            `${installation.pluginId} on ${installation.machineId}: native installation ${installation.revision} changed since the crossing; restore refused`,
          );
        if (now.enabled === 0)
          reenable.run(
            installation.machineId,
            installation.pluginId,
            installation.revision,
            installation.artifact,
          );
      }
    }
  });
  writeReplacementJournal(dataDir, journal.slice(0, journal.length - revisions.length));
  for (const bundlePath of removed) removeInstall({ bundlePath });
  clearStagedReplacement(dataDir);
  return newest;
}
