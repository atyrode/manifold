import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
import {
  inspectArtifact,
  installLayout,
  removeInstall,
  type VerifiedPluginArtifact,
} from "./plugin-installs.ts";
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
    plugin-replacement/journal.json                          crossings, oldest first, each
                                                             prepared → committed → completed
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

/** fsync one file or directory: a rename or unlink is durable once its directory is. */
function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The replacement directory, whose own entry in the data directory is durable too. */
function durableReplacementRoot(dataDir: string): string {
  const root = join(dataDir, PLUGIN_REPLACEMENT_DIR);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    syncPath(dataDir);
  }
  return root;
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
 * digest, then replace any previously staged set whole and durably. `revision` is the
 * deploying commit.
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
  const root = durableReplacementRoot(dataDir);
  const incoming = mkdtempSync(join(root, ".incoming-"));
  try {
    for (const name of [SET_FILE, ...verified.set.members.map((m) => m.sha256 + BUNDLE_SUFFIX)])
      copyFileSync(join(source, name), join(incoming, name));
    writeFileSync(join(incoming, REVISION_FILE), revision, { mode: 0o600 });
    await readReplacementDirectory(incoming, setSha256);
    for (const name of readdirSync(incoming)) syncPath(join(incoming, name));
    syncPath(incoming);
    rmSync(staged, { recursive: true, force: true });
    renameSync(incoming, staged);
    syncPath(root);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  return verified;
}

/** Removes a staged set durably: a completed crossing's set never reappears after a crash. */
export function clearStagedReplacement(dataDir: string): void {
  const staged = stagedReplacementDir(dataDir);
  if (!existsSync(staged)) return;
  rmSync(staged, { recursive: true, force: true });
  syncPath(join(dataDir, PLUGIN_REPLACEMENT_DIR));
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

/**
 * A row as `plugin_installs` persists it, canonically: every column the installer writes,
 * including grants, hardening, installer lineage and the installation time. Rows that persist
 * alike carry the same installation decision; any later install writes its own.
 */
function persistedRow(row: PluginInstallRow): string {
  return canonicalJobJson({
    pluginId: row.pluginId,
    sha256: row.sha256,
    source: row.source,
    grantedCaps: row.grantedCaps,
    installedBy: row.installedBy,
    installedAt: row.installedAt,
    bundlePath: row.bundlePath,
    actions: row.actions,
    hardened: row.hardened === true,
    builtAgainst: row.builtAgainst ?? null,
    mode: row.mode ?? "bundle",
    installer: row.installer ?? null,
  });
}

export function sameInstallRow(row: PluginInstallRow | undefined, expected: PluginInstallRow) {
  return row !== undefined && persistedRow(row) === persistedRow(expected);
}

const NativeInstallationSchema = z.strictObject({
  machineId: z.string().min(1),
  pluginId: z.string().min(1),
  revision: z.string().min(1),
  artifact: hash,
});
export type ReplacedNativeInstallation = z.infer<typeof NativeInstallationSchema>;

const ReplacementRecordSchema = z
  .strictObject({
    format: z.literal(1),
    setSha256: hash,
    revision: z.string().regex(REVISION),
    appliedAt: z.number().int().nonnegative(),
    /**
     * `prepared`: journaled before the installer group ran. `committed`: the group committed,
     * and each member's `committed` is the exact row it wrote. `completed`: the native half
     * finished as well, so nothing of this crossing is ever resumed or re-applied.
     */
    phase: z.enum(["prepared", "committed", "completed"]),
    members: z
      .array(
        z.strictObject({
          sha256: hash,
          previous: InstallRowSchema,
          committed: InstallRowSchema.nullable(),
          nativeReview: z.boolean(),
        }),
      )
      .min(1),
    /** Enabled native installations the crossing disabled, recorded before it disabled them. */
    disabledInstallations: NativeInstallationSchema.array(),
  })
  .refine(
    ({ phase, members }) =>
      members.every(({ sha256, previous, committed }) =>
        phase === "prepared"
          ? committed === null
          : committed?.sha256 === sha256 && committed.pluginId === previous.pluginId,
      ),
    { message: "replacement record rows do not match its phase" },
  );
export type ReplacementRecord = z.infer<typeof ReplacementRecordSchema>;
/** Each crossing completes or is dropped before the next applies: only the newest may not. */
const JournalSchema = ReplacementRecordSchema.array().refine(
  (records) => records.slice(0, -1).every((record) => record.phase === "completed"),
  { message: "only the newest replacement record may be unfinished" },
);

export function readReplacementJournal(dataDir: string): ReplacementRecord[] {
  const path = join(dataDir, PLUGIN_REPLACEMENT_DIR, JOURNAL_FILE);
  if (!existsSync(path)) return [];
  return JournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Durable before any effect it describes, as the plugin database journal is: the next journal is
 * written and fsynced under a temporary name, renamed over the journal, and the directory is
 * fsynced. A host crash leaves the previous journal or this one, never an applied crossing or a
 * restore without its record. An empty journal is an unlinked one, made durable the same way.
 */
export function writeReplacementJournal(
  dataDir: string,
  records: readonly ReplacementRecord[],
): void {
  const parsed = JournalSchema.parse(records);
  const root = join(dataDir, PLUGIN_REPLACEMENT_DIR);
  const path = join(root, JOURNAL_FILE);
  if (parsed.length === 0) {
    if (!existsSync(path)) return;
    rmSync(path);
    syncPath(root);
    return;
  }
  durableReplacementRoot(dataDir);
  const next = `${path}.next`;
  const fd = openSync(next, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(parsed)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, path);
  syncPath(root);
}

/** What a rollback gate proves and its switch binds: the crossings one restore undoes. */
export interface RestorePlanCrossing {
  readonly revision: string;
  readonly setSha256: string;
  readonly members: readonly {
    readonly pluginId: string;
    readonly sha256: string;
    readonly previousSha256: string;
  }[];
}

export function restorePlanCrossing(record: ReplacementRecord): RestorePlanCrossing {
  return {
    revision: record.revision,
    setSha256: record.setSha256,
    members: record.members.map(({ previous, sha256 }) => ({
      pluginId: previous.pluginId,
      sha256,
      previousSha256: previous.sha256,
    })),
  };
}

/**
 * A restore plan's identity, newest crossing first: the sha256 of its canonical JSON, or
 * `none` when the rollback restores nothing. The installed-bundles gate computes it from the
 * export it proved, and the host's restore refuses any other.
 */
export function restorePlanDigest(crossings: readonly RestorePlanCrossing[]): string {
  if (crossings.length === 0) return "none";
  return sha256Hex(
    canonicalJobJson(
      crossings.map(({ revision, setSha256, members }) => ({
        revision,
        setSha256,
        members: members.map(({ pluginId, sha256, previousSha256 }) => ({
          pluginId,
          sha256,
          previousSha256,
        })),
      })),
    ),
  );
}

/** The bundle a member crossed to: the row its group committed, or where the group writes it. */
function crossedBundlePath(dataDir: string, member: ReplacementRecord["members"][number]) {
  return resolve(
    member.committed?.bundlePath ??
      installLayout(dataDir, member.previous.pluginId, member.sha256).bundlePath,
  );
}

/**
 * THE ROLLBACK HALF. Restores the newest journal records, newest first and named exactly, so the
 * previous hub boots its previous bundles: each plugin returns to the previous row of the oldest
 * restored crossing that replaced it, and each native installation a crossing disabled is
 * re-enabled at the same revision and artifact, the approval it held before. When `plan` is
 * given it must be the digest of exactly these crossings.
 *
 * A row is restored only if it is EXACTLY one the journal recorded for it: a crossing's
 * committed row, or a previous row along the restored chain (a crossing never committed, or a
 * restore that committed before its journal was truncated, which a retry completes). A row
 * written by anything else, even a reinstall of the same digest with other grants, hardening or
 * installer, or an installation that moved since, refuses the whole restore: restoring over it
 * would discard a later decision. Rows and native installations change in one transaction;
 * the journal is truncated only after it commits. A restored crossing's bundle file goes only
 * once neither an installed row nor a remaining record names it, so a later restore of an
 * earlier crossing still reads its bytes when a newer crossing returned to the same digest.
 */
export function restoreReplacements(
  store: ServerStore,
  dataDir: string,
  revisions: readonly string[],
  plan?: string,
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
  if (plan !== undefined && restorePlanDigest(newest.map(restorePlanCrossing)) !== plan)
    throw new Error(
      `restore plan ${plan} is not the journaled crossings ${revisions.join(", ")}; restore refused`,
    );
  // Each plugin's journaled chain, newest crossing first: the rows it may hold now, and the
  // previous row of the oldest restored crossing, which it gets.
  const chains = new Map<
    string,
    { readonly revision: string; readonly accepts: PluginInstallRow[]; target: PluginInstallRow }
  >();
  // A prepared record's group may have committed just before a crash, with no hub serving it
  // since: every boot resolves a prepared record before it serves.
  const prepared = new Map<string, string>();
  for (const record of newest)
    for (const member of record.members) {
      const pluginId = member.previous.pluginId;
      const chain = chains.get(pluginId) ?? {
        revision: record.revision,
        accepts: [],
        target: member.previous,
      };
      if (member.committed !== null) chain.accepts.push(member.committed);
      else prepared.set(pluginId, member.sha256);
      chain.accepts.push(member.previous);
      chain.target = member.previous;
      chains.set(pluginId, chain);
    }
  store.transaction(() => {
    const rows = new Map(store.pluginInstalls().map((row) => [row.pluginId, row]));
    for (const [pluginId, chain] of chains) {
      const row = rows.get(pluginId);
      if (
        row === undefined ||
        (row.sha256 !== prepared.get(pluginId) &&
          !chain.accepts.some((accepted) => sameInstallRow(row, accepted)))
      )
        throw new Error(
          `${pluginId}: the installed row changed since crossing ${chain.revision}; restore refused`,
        );
      if (!sameInstallRow(row, chain.target)) store.putPluginInstall(chain.target);
    }
    const reenable = store.db.query<void, [string, string, string, string]>(
      "UPDATE machine_job_installs SET enabled=1, ready=0 WHERE machine_id=? AND plugin_id=? AND revision=? AND artifact=? AND enabled=0 AND purge_requested=0",
    );
    const current = store.db.query<
      { revision: string; artifact: string; enabled: number; purge_requested: number },
      [string, string]
    >(
      "SELECT revision, artifact, enabled, purge_requested FROM machine_job_installs WHERE machine_id=? AND plugin_id=?",
    );
    for (const record of newest)
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
  });
  const remaining = journal.slice(0, journal.length - revisions.length);
  writeReplacementJournal(dataDir, remaining);
  const kept = new Set([
    ...store.pluginInstalls().map((row) => resolve(row.bundlePath)),
    ...remaining.flatMap((record) =>
      record.members.flatMap((member) => [
        resolve(member.previous.bundlePath),
        crossedBundlePath(dataDir, member),
      ]),
    ),
  ]);
  for (const record of newest)
    for (const member of record.members) {
      const bundlePath = crossedBundlePath(dataDir, member);
      if (!kept.has(bundlePath)) removeInstall({ bundlePath });
    }
  clearStagedReplacement(dataDir);
  return newest;
}
