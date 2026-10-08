import { version as reactVersion } from "react";
import {
  CAPS,
  CORE_NAMESPACE_PREFIX,
  ENGINE_NAMESPACE_PREFIX,
  GOVERNED_CAPS,
  HARDENED_CONTRACT_COMPAT_VERSIONS,
  MAX_PLUGIN_UPDATE_FAMILY,
  PLUGIN_BUNDLE_PROTOCOL_COMPAT_VERSIONS,
  PROTOCOL_VERSION,
  canonicalJobJson,
  hasCap,
  isEngineCap,
  type AuthoredCap,
  type PluginBuildCompatibility,
  type PluginBundle,
  type PluginRosterEntry,
  type PluginUpdateApplyRequest,
  type PluginUpdateApplyResult,
  type PluginUpdateMember,
  type PluginUpdateReview,
  type PluginUpdateReviewResult,
  type PluginUpdateStatus,
} from "@manifold/protocol";
import { familyOrder, requiredDependencyIds } from "@manifold/plugin-kit/install";
import type { PluginInstallResult } from "@manifold/plugin";
import type { CredentialReference } from "./auth.ts";
import type { ActionRefused } from "./plugin-host.ts";
import { inspectArtifact, type VerifiedPluginArtifact } from "./plugin-installs.ts";
import { discoverPluginRelease, readPluginChangelog } from "./plugin-releases.ts";
import { sha256Hex, type PluginInstallRow, type ServerStore } from "./stores.ts";
import { BUILT_AGAINST_PROTOCOL } from "@manifold/plugin-kit/pack";

const POLL_MS = 60 * 60 * 1000;
const REVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_REVIEWS = 8;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 32 * 1024 * 1024;
const MAX_REVIEW_BYTES = 512 * 1024;
const MAX_DISCOVERIES = 2;
const DISCOVERY_TIMEOUT_MS = 60_000;

/** Missing legacy build metadata is a warning, not evidence of an incompatible binary. */
export function pluginBuildCompatibility(bundle: PluginBundle): PluginBuildCompatibility {
  const issues: PluginBuildCompatibility["issues"] = [];
  const protocol = bundle.builtAgainst?.[BUILT_AGAINST_PROTOCOL];
  const currentProtocol = String(PROTOCOL_VERSION);
  if (protocol === undefined || !PLUGIN_BUNDLE_PROTOCOL_COMPAT_VERSIONS.has(protocol)) {
    issues.push({
      component: BUILT_AGAINST_PROTOCOL,
      built: protocol?.slice(0, 128) ?? null,
      current: currentProtocol,
      kind: protocol === undefined ? "unknown" : "incompatible",
    });
  }
  const react = bundle.builtAgainst?.react;
  if (react !== undefined) {
    const builtMajor = /^(\d+)\./.exec(react)?.[1];
    const currentMajor = /^(\d+)\./.exec(reactVersion)?.[1];
    if (builtMajor === undefined || builtMajor !== currentMajor) {
      issues.push({
        component: "react",
        built: react.slice(0, 128),
        current: reactVersion,
        kind: builtMajor === undefined ? "unknown" : "incompatible",
      });
    }
  }
  return {
    status: issues.some((issue) => issue.kind === "incompatible")
      ? "incompatible"
      : issues.length > 0
        ? "unknown"
        : "compatible",
    issues,
  };
}

export interface PluginUpdateAuthority {
  readonly principalId: string;
  readonly credential: CredentialReference;
  readonly assertCurrent: () => void;
  /** Called synchronously after durable installation, before its single roster publication. */
  readonly committed?: () => void;
}

export interface PreparedPluginUpdate {
  readonly artifact: VerifiedPluginArtifact;
  readonly grantedCaps: AuthoredCap[];
  readonly hardened: boolean;
}

type Installed = { readonly row: PluginInstallRow; readonly bundle: PluginBundle | null };

/** The host retains the sole assembly lock, installer, native guard and publication path. */
export interface PluginUpdateHost {
  installed(): ReadonlyMap<string, Installed>;
  roster(): readonly PluginRosterEntry[];
  nativeSnapshot(ids: readonly string[]): string;
  serialize<T>(run: () => Promise<T>): Promise<T>;
  apply(
    members: readonly PreparedPluginUpdate[],
    authority: PluginUpdateAuthority,
  ): Promise<readonly PluginInstallResult[] | ActionRefused>;
  publish(): void;
}

interface Options {
  readonly store: ServerStore;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly host: PluginUpdateHost;
}

interface Observation {
  readonly fingerprint: string;
  readonly ids: readonly string[];
  readonly status: PluginUpdateStatus;
}

interface Discovery {
  readonly rootId: string;
  readonly fingerprint: string;
  readonly ids: readonly string[];
  readonly checkedAt: number;
  /** Null means every preferred pin already equals its verified incumbent. */
  readonly artifacts: readonly VerifiedPluginArtifact[] | null;
}

interface CachedReview {
  readonly review: PluginUpdateReview;
  readonly actor: string;
  readonly fingerprint: string;
  readonly members: readonly PreparedPluginUpdate[];
  readonly bytes: number;
  readonly checkedAt: number;
}

class UpdateRefusal extends Error {
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "UpdateRefusal";
  }
}

function failureMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : "update_failed: candidate inspection failed"
  ).slice(0, 1000);
}

export function covers(caps: readonly AuthoredCap[], cap: AuthoredCap): boolean {
  return cap === "*" ? caps.includes("*") : hasCap(caps, cap);
}

/** Consent to a wider ceiling must not restore a previously withheld part of that ceiling. */
export function prospectiveGrant(
  previous:
    | {
        readonly row: { readonly grantedCaps: readonly AuthoredCap[] };
        readonly bundle: PluginBundle | null;
      }
    | undefined,
  declared: readonly AuthoredCap[],
): AuthoredCap[] {
  const before = previous?.bundle?.manifest.capabilities ?? [];
  const granted = previous?.row.grantedCaps ?? [];
  const allowed = (cap: AuthoredCap): boolean =>
    !GOVERNED_CAPS.includes(cap) &&
    covers(declared, cap) &&
    (covers(granted, cap) || !covers(before, cap));
  const engine = CAPS.filter((cap) => cap !== "*" && allowed(cap));
  const own = [...new Set(declared.filter((cap) => !isEngineCap(cap) && allowed(cap)))].sort();
  // Keep wildcard semantics only if no formerly withheld ordinary authority would reappear.
  const allOrdinary = CAPS.every(
    (cap) => cap === "*" || GOVERNED_CAPS.includes(cap) || allowed(cap),
  );
  return declared.includes("*") && allOrdinary ? ["*", ...own] : [...engine, ...own];
}

function description(
  bundle: PluginBundle,
  sha256: string,
  source: string,
): PluginUpdateMember["candidate"] {
  return {
    version: bundle.manifest.version,
    sha256,
    source,
    capabilities: bundle.manifest.capabilities,
    dependencies: bundle.manifest.dependencies ?? {},
    entry: bundle.manifest.entry,
    machine: bundle.manifest.machine !== undefined,
    dataVersion: bundle.manifest.dataVersion ?? null,
    ...(bundle.builtAgainst === undefined ? {} : { builtAgainst: bundle.builtAgainst }),
  };
}

function memberOf(id: string, rootId: string): boolean {
  return id === rootId || id.startsWith(`${rootId}.`);
}

/** Bounded, actor-bound, in-memory approvals. Discovery never loads candidate JavaScript. */
export class PluginUpdates {
  private readonly observations = new Map<string, Observation>();
  private readonly discoveries = new Map<string, Promise<Discovery>>();
  private readonly reviews = new Map<string, CachedReview>();
  private cachedBytes = 0;
  private reviewing = 0;
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private polling: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: Options) {
    this.signal = AbortSignal.any([options.signal, this.lifetime.signal]);
    this.signal.addEventListener("abort", () => this.close(), { once: true });
    if (this.signal.aborted) this.close();
  }

  private assertOpen(): void {
    this.signal.throwIfAborted();
  }

  private rootId(id: string): string {
    const installed = this.options.host.installed();
    if (!installed.has(id))
      throw new UpdateRefusal("not_installed", `"${id}" is not an installed bundle`);
    let root = id;
    for (let dot = id.lastIndexOf("."); dot > 0; dot = id.lastIndexOf(".", dot - 1)) {
      const parent = id.slice(0, dot);
      if (installed.has(parent)) root = parent;
    }
    return root;
  }

  private family(rootId: string): readonly [string, Installed][] {
    const family = [...this.options.host.installed()].filter(([id]) => memberOf(id, rootId));
    if (family.length === 0 || family.length > MAX_PLUGIN_UPDATE_FAMILY)
      throw new UpdateRefusal(
        "update_unavailable",
        `family size must be between 1 and ${String(MAX_PLUGIN_UPDATE_FAMILY)}`,
      );
    for (const [id, installed] of family) {
      if (id.startsWith(CORE_NAMESPACE_PREFIX) || id.startsWith(ENGINE_NAMESPACE_PREFIX))
        throw new UpdateRefusal(
          "namespace_reserved",
          `"${id}" updates with the Manifold distribution`,
        );
      if (installed.row.mode === "unpacked")
        throw new UpdateRefusal(
          "update_unavailable",
          `"${id}" belongs to its unpacked source tree`,
        );
      if (installed.bundle === null)
        throw new UpdateRefusal("update_unavailable", `"${id}" has no verified incumbent bundle`);
    }
    return family;
  }

  /** Read committed rows, never the host's temporary candidate definitions during preparation. */
  private snapshot(rootId: string, candidateIds: readonly string[]): string {
    const rows = this.options.store
      .pluginInstalls()
      .filter((row) => memberOf(row.pluginId, rootId));
    const ids = [...new Set([...candidateIds, ...rows.map((row) => row.pluginId)])].sort();
    const disabled = this.options.store.disabledPlugins();
    return sha256Hex(
      canonicalJobJson({
        rows: rows.map((row) => ({
          id: row.pluginId,
          sha256: row.sha256,
          source: row.source,
          grants: row.grantedCaps,
          hardened: row.hardened === true,
          mode: row.mode ?? "bundle",
          installedAt: row.installedAt,
          installedBy: row.installedBy,
          installer: row.installer ?? null,
        })),
        members: ids.map((id) => ({
          id,
          enabled: !disabled.has(id),
          dataVersion: this.options.store.pluginDataVersion(id),
        })),
        native: this.options.host.nativeSnapshot(ids),
      }),
    );
  }

  private assertSnapshot(rootId: string, ids: readonly string[], expected: string): void {
    this.assertOpen();
    if (this.snapshot(rootId, ids) !== expected)
      throw new UpdateRefusal("review_stale", "the installed family changed; review it again");
  }

  private observe(rootId: string, observation: Observation): void {
    if (this.closed) return;
    this.observations.set(rootId, observation);
    this.options.host.publish();
  }

  roster(rows: readonly PluginRosterEntry[]): PluginRosterEntry[] {
    const installed = this.options.host.installed();
    const statuses = new Map<string, PluginUpdateStatus>();
    return rows.map((entry) => {
      const current = installed.get(entry.manifest.id);
      if (entry.install === undefined || current?.bundle == null) return entry;
      const rootId = this.rootId(entry.manifest.id);
      const root = installed.get(rootId);
      let update: PluginUpdateStatus | undefined;
      if (root?.bundle?.manifest.releases !== undefined && root.row.mode !== "unpacked") {
        update = statuses.get(rootId);
        if (update === undefined) {
          const observation = this.observations.get(rootId);
          update =
            observation !== undefined &&
            observation.fingerprint === this.snapshot(rootId, observation.ids)
              ? observation.status
              : { state: "unchecked" };
          statuses.set(rootId, update);
        }
      }
      return {
        ...entry,
        install: {
          ...entry.install,
          compatibility: pluginBuildCompatibility(current.bundle),
          ...(update === undefined ? {} : { update }),
        },
      };
    });
  }

  private discover(rootId: string, signal: AbortSignal): Promise<Discovery> {
    const running = this.discoveries.get(rootId);
    if (running !== undefined) return running;
    if (this.discoveries.size >= MAX_DISCOVERIES)
      return Promise.reject(
        new UpdateRefusal(
          "update_unavailable",
          "two families are already being checked; try again shortly",
        ),
      );
    const discovery = this.discoverNext(rootId, signal).finally(() => {
      this.discoveries.delete(rootId);
    });
    this.discoveries.set(rootId, discovery);
    return discovery;
  }

  private async discoverNext(rootId: string, parentSignal: AbortSignal): Promise<Discovery> {
    this.assertOpen();
    const family = this.family(rootId);
    const root = family.find(([id]) => id === rootId)?.[1];
    const source = root?.bundle?.manifest.releases;
    if (source === undefined)
      throw new UpdateRefusal("update_unavailable", `"${rootId}" declares no release source`);
    const currentIds = family.map(([id]) => id);
    const fingerprint = this.snapshot(rootId, currentIds);
    this.observe(rootId, { fingerprint, ids: currentIds, status: { state: "checking" } });
    const signal = AbortSignal.any([
      this.signal,
      parentSignal,
      AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    ]);
    try {
      const release = await discoverPluginRelease({
        id: rootId,
        source,
        dataDir: this.options.dataDir,
        signal,
      });
      this.assertSnapshot(rootId, currentIds, fingerprint);
      const pins = new Map(release.artifacts.map((artifact) => [artifact.id, artifact]));
      if (
        pins.size !== release.artifacts.length ||
        !pins.has(rootId) ||
        pins.size > MAX_PLUGIN_UPDATE_FAMILY
      )
        throw new UpdateRefusal(
          "artifact_invalid",
          "the release must name its root and each family member exactly once",
        );
      for (const id of pins.keys()) {
        if (!memberOf(id, rootId))
          throw new UpdateRefusal(
            "artifact_invalid",
            `release member "${id}" is outside "${rootId}"`,
          );
        const compiled = this.options.host
          .roster()
          .find((entry) => entry.manifest.id === id && entry.install === undefined);
        if (compiled !== undefined)
          throw new UpdateRefusal("namespace_reserved", `"${id}" is owned by the distribution`);
      }
      for (const id of currentIds) {
        if (!pins.has(id))
          throw new UpdateRefusal(
            "artifact_invalid",
            `release omits installed family member "${id}"`,
          );
      }
      const ids = [...pins.keys()].sort();
      const allCurrent =
        ids.length === family.length &&
        family.every(([id, current]) => pins.get(id)?.sha256.toLowerCase() === current.row.sha256);
      const checkedAt = this.options.now();
      if (allCurrent) {
        if (release.version !== null && release.version !== root?.bundle?.manifest.version)
          throw new UpdateRefusal(
            "artifact_invalid",
            "release version disagrees with its pinned root bundle",
          );
        const current: Discovery = {
          rootId,
          ids,
          fingerprint: this.snapshot(rootId, ids),
          checkedAt,
          artifacts: null,
        };
        this.observe(rootId, {
          fingerprint: current.fingerprint,
          ids,
          status: { state: "current", checkedAt },
        });
        return current;
      }
      const artifacts: VerifiedPluginArtifact[] = [];
      let bytes = 0;
      for (const pin of pins.values()) {
        const artifact = await inspectArtifact({
          source: pin.url,
          sha256: pin.sha256.toLowerCase(),
          dataDir: this.options.dataDir,
          signal,
        });
        this.assertSnapshot(rootId, currentIds, fingerprint);
        if (artifact.bundle.manifest.id !== pin.id)
          throw new UpdateRefusal(
            "artifact_invalid",
            `pin for "${pin.id}" contains a different plugin id`,
          );
        bytes += artifact.bytes.byteLength;
        if (bytes > MAX_CANDIDATE_BYTES)
          throw new UpdateRefusal(
            "artifact_invalid",
            "candidate family exceeds the 32 MiB review limit",
          );
        artifacts.push(artifact);
      }
      const candidateRoot = artifacts.find((artifact) => artifact.bundle.manifest.id === rootId)!;
      if (release.version !== null && release.version !== candidateRoot.bundle.manifest.version)
        throw new UpdateRefusal(
          "artifact_invalid",
          "release version disagrees with its pinned root bundle",
        );
      const ordered = familyOrder(
        artifacts.map((artifact) => ({
          id: artifact.bundle.manifest.id,
          requiredDependencies: requiredDependencyIds(artifact.bundle.manifest),
          artifact,
        })),
      ).map(({ artifact }) => artifact);
      const discovered: Discovery = {
        rootId,
        ids,
        fingerprint: this.snapshot(rootId, ids),
        checkedAt: this.options.now(),
        artifacts: ordered,
      };
      this.observe(rootId, {
        fingerprint: discovered.fingerprint,
        ids,
        status: {
          state: "available",
          checkedAt: discovered.checkedAt,
          version: candidateRoot.bundle.manifest.version,
          family: ids,
        },
      });
      return discovered;
    } catch (error) {
      if (
        !this.signal.aborted &&
        !parentSignal.aborted &&
        this.snapshot(rootId, currentIds) === fingerprint
      )
        this.observe(rootId, {
          fingerprint,
          ids: currentIds,
          status: {
            state: "failed",
            checkedAt: this.options.now(),
            message: failureMessage(error),
          },
        });
      throw error;
    }
  }

  private actor(authority: PluginUpdateAuthority): string {
    return sha256Hex(
      canonicalJobJson({ principalId: authority.principalId, credential: authority.credential }),
    );
  }

  async review(
    id: string,
    authority: PluginUpdateAuthority,
  ): Promise<PluginUpdateReviewResult | ActionRefused> {
    if (this.reviewing >= MAX_DISCOVERIES)
      return {
        refused:
          "update_unavailable: two candidate reviews are already being prepared; try again shortly",
      };
    this.reviewing++;
    try {
      authority.assertCurrent();
      const rootId = this.rootId(id);
      const discovered = await this.discover(rootId, this.signal);
      authority.assertCurrent();
      this.assertSnapshot(rootId, discovered.ids, discovered.fingerprint);
      if (discovered.artifacts === null)
        return { state: "current", rootId, checkedAt: discovered.checkedAt };
      const installed = this.options.host.installed();
      const root = installed.get(rootId)!;
      const disabled = this.options.store.disabledPlugins();
      const roster = new Map(this.options.host.roster().map((row) => [row.manifest.id, row]));
      const members: PluginUpdateMember[] = [];
      const prepared: PreparedPluginUpdate[] = [];
      const blockers: PluginUpdateReview["blockers"] = [];
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
      for (const artifact of discovered.artifacts) {
        const manifest = artifact.bundle.manifest;
        const previous = installed.get(manifest.id);
        const before = previous?.bundle?.manifest.capabilities ?? [];
        const storedDataVersion = this.options.store.pluginDataVersion(manifest.id);
        const hardened = (previous === undefined ? root.row : previous.row).hardened === true;
        const compatibility = pluginBuildCompatibility(artifact.bundle);
        if (compatibility.status === "incompatible")
          blockers.push({
            id: manifest.id,
            reason:
              "repack_required: the candidate targets an incompatible protocol or shared React major",
          });
        if (
          artifact.bundle.hardenedContract === undefined ||
          !HARDENED_CONTRACT_COMPAT_VERSIONS.has(artifact.bundle.hardenedContract)
        )
          blockers.push({
            id: manifest.id,
            reason: "repack_required: the candidate does not declare an accepted hardened contract",
          });
        if (
          storedDataVersion !== null &&
          manifest.dataVersion !== undefined &&
          storedDataVersion.major > manifest.dataVersion.major
        )
          blockers.push({
            id: manifest.id,
            reason:
              "data_downgrade: retained data is newer than the candidate's declared major version",
          });
        const changelog = await readPluginChangelog(artifact, {
          dataDir: this.options.dataDir,
          signal,
        });
        authority.assertCurrent();
        this.assertSnapshot(rootId, discovered.ids, discovered.fingerprint);
        const grantedCaps = prospectiveGrant(previous, manifest.capabilities);
        members.push({
          id: manifest.id,
          title: manifest.title,
          current:
            previous?.bundle == null
              ? null
              : {
                  ...description(previous.bundle, previous.row.sha256, previous.row.source),
                  enabled: roster.get(manifest.id)?.enabled === true,
                },
          candidate: description(artifact.bundle, artifact.sha256, artifact.source),
          enabled: !disabled.has(manifest.id),
          hardened,
          storedDataVersion,
          capabilitiesAdded: [
            ...new Set(manifest.capabilities.filter((cap) => !covers(before, cap))),
          ],
          capabilitiesRemoved: [
            ...new Set(before.filter((cap) => !covers(manifest.capabilities, cap))),
          ],
          grantedCaps,
          migrationRequired:
            storedDataVersion !== null &&
            manifest.dataVersion !== undefined &&
            storedDataVersion.major < manifest.dataVersion.major,
          compatibility,
          changelog,
        });
        prepared.push({ artifact, grantedCaps, hardened });
      }
      return await this.options.host.serialize(async () => {
        authority.assertCurrent();
        this.assertSnapshot(rootId, discovered.ids, discovered.fingerprint);
        const createdAt = this.options.now();
        const actor = this.actor(authority);
        const body = { rootId, createdAt, expiresAt: createdAt + REVIEW_TTL_MS, members, blockers };
        const serialized = canonicalJobJson(body);
        if (Buffer.byteLength(serialized) > MAX_REVIEW_BYTES)
          throw new UpdateRefusal(
            "artifact_invalid",
            "candidate review exceeds the 512 KiB response limit",
          );
        const digest = sha256Hex(
          canonicalJobJson({ actor, fingerprint: discovered.fingerprint, body }),
        );
        const review: PluginUpdateReview = { digest, ...body };
        const bytes = prepared.reduce(
          (total, member) => total + member.artifact.bytes.byteLength,
          Buffer.byteLength(serialized),
        );
        this.expireReviews();
        while (this.reviews.size >= MAX_REVIEWS || this.cachedBytes + bytes > MAX_CACHED_BYTES) {
          const oldest = this.reviews.keys().next().value;
          if (oldest === undefined) break;
          this.forget(oldest);
        }
        this.forget(digest);
        this.reviews.set(digest, {
          review,
          actor,
          fingerprint: discovered.fingerprint,
          members: prepared,
          bytes,
          checkedAt: discovered.checkedAt,
        });
        this.cachedBytes += bytes;
        return { state: "review", review };
      });
    } catch (error) {
      return { refused: failureMessage(error) };
    } finally {
      this.reviewing--;
    }
  }

  async apply(
    request: PluginUpdateApplyRequest,
    authority: PluginUpdateAuthority,
  ): Promise<PluginUpdateApplyResult | ActionRefused> {
    try {
      return await this.options.host.serialize(async () => {
        this.assertOpen();
        authority.assertCurrent();
        const cached = this.reviews.get(request.digest);
        if (cached === undefined)
          throw new UpdateRefusal(
            "review_missing",
            "review this candidate again before applying it",
          );
        if (cached.actor !== this.actor(authority))
          throw new UpdateRefusal("forbidden", "the review belongs to a different credential");
        this.forget(request.digest);
        const review = cached.review;
        if (review.expiresAt <= this.options.now())
          throw new UpdateRefusal(
            "review_expired",
            "review this candidate again before applying it",
          );
        const ids = review.members.map((member) => member.id);
        this.assertSnapshot(review.rootId, ids, cached.fingerprint);
        if (review.blockers.length > 0)
          throw new UpdateRefusal(
            "update_blocked",
            "resolve the candidate's compatibility or data blockers first",
          );
        const expected = review.members.filter((member) => member.capabilitiesAdded.length > 0);
        if (
          request.consent.length !== expected.length ||
          new Set(request.consent.map((member) => member.id)).size !== expected.length
        )
          throw new UpdateRefusal(
            "consent_required",
            "acknowledge every expanded capability ceiling exactly once",
          );
        for (const member of expected) {
          const consent = request.consent.find((item) => item.id === member.id)?.capabilities;
          if (
            consent === undefined ||
            consent.length !== member.capabilitiesAdded.length ||
            new Set(consent).size !== consent.length ||
            !member.capabilitiesAdded.every((cap) => consent.includes(cap))
          )
            throw new UpdateRefusal(
              "consent_required",
              `acknowledge the exact capability additions for "${member.id}"`,
            );
        }
        const result = await this.options.host.apply(cached.members, {
          ...authority,
          assertCurrent: () => {
            authority.assertCurrent();
            if (review.expiresAt <= this.options.now())
              throw new UpdateRefusal(
                "review_expired",
                "the review expired before installation committed",
              );
            this.assertSnapshot(review.rootId, ids, cached.fingerprint);
          },
          committed: () => {
            for (const [digest, sibling] of this.reviews) {
              if (sibling.review.rootId === review.rootId) this.forget(digest);
            }
            this.observations.set(review.rootId, {
              ids,
              fingerprint: this.snapshot(review.rootId, ids),
              status: { state: "current", checkedAt: cached.checkedAt },
            });
          },
        });
        if ("refused" in result) return result;
        // The installer has committed and published. Do not re-run a pre-commit guard now.
        return {
          rootId: review.rootId,
          installed: cached.members.map(({ artifact }) => ({
            id: artifact.bundle.manifest.id,
            version: artifact.bundle.manifest.version,
            sha256: artifact.sha256,
          })),
        };
      });
    } catch (error) {
      return { refused: failureMessage(error) };
    }
  }

  private forget(digest: string): void {
    const cached = this.reviews.get(digest);
    if (cached === undefined) return;
    this.cachedBytes -= cached.bytes;
    this.reviews.delete(digest);
  }

  private expireReviews(): void {
    const now = this.options.now();
    for (const [digest, cached] of this.reviews) {
      if (cached.review.expiresAt <= now) this.forget(digest);
    }
  }

  startPolling(): () => void {
    if (this.polling === null && !this.closed) {
      this.polling = new AbortController();
      void this.poll(this.polling);
    }
    return () => this.stopPolling();
  }

  private async poll(controller: AbortController): Promise<void> {
    try {
      this.expireReviews();
      const roots = new Set<string>();
      for (const [id, installed] of this.options.host.installed()) {
        if (
          installed.bundle?.manifest.releases !== undefined &&
          installed.row.mode !== "unpacked" &&
          this.rootId(id) === id
        )
          roots.add(id);
      }
      for (const rootId of roots) {
        if (controller.signal.aborted || this.closed) break;
        try {
          await this.discover(rootId, controller.signal);
        } catch (error) {
          // Discovery failures are roster observations, not hidden timer rejections.
          if (!controller.signal.aborted && !this.closed) {
            const ids = [...this.options.host.installed().keys()].filter((id) =>
              memberOf(id, rootId),
            );
            this.observe(rootId, {
              ids,
              fingerprint: this.snapshot(rootId, ids),
              status: {
                state: "failed",
                checkedAt: this.options.now(),
                message: failureMessage(error),
              },
            });
          }
        }
      }
    } finally {
      if (!controller.signal.aborted && !this.closed) {
        this.timer = setTimeout(() => {
          void this.poll(controller);
        }, POLL_MS);
        this.timer.unref();
      }
    }
  }

  private stopPolling(): void {
    this.polling?.abort();
    this.polling = null;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPolling();
    this.lifetime.abort();
    this.reviews.clear();
    this.cachedBytes = 0;
    this.observations.clear();
  }
}
