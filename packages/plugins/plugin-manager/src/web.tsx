import "./styles.css";
import {
  ENGINE_APPLY_UPDATE_ACTION,
  ENGINE_INSTALL_ACTION,
  ENGINE_PURGE_ACTION,
  ENGINE_REVIEW_UPDATE_ACTION,
  ENGINE_SET_DEVELOPER_MODE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  ENGINE_SET_SETTING_ACTION,
  ENGINE_UNINSTALL_ACTION,
  PluginInstallResultSchema,
  type ComposedSetting,
  type SectionProps,
} from "@manifold/plugin";
import {
  GOVERNED_CAPS,
  PLUGIN_PURGE_TARGETS,
  PluginPurgeResultSchema,
  PluginUpdateApplyResultSchema,
  PluginUpdateReviewResultSchema,
  type ActionSummary,
  type Cap,
  type ManifoldRef,
  type PluginBuildCompatibility,
  type PluginPurgeResult,
  type PluginPurgeTarget,
  type PluginRosterEntry,
  type PluginUpdateMember,
  type PluginUpdateReview,
  type PluginUpdateStatus,
  type TileLayout,
} from "@manifold/protocol";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { Cluster, ControlIcon, ScrollRegion, Stack } from "@manifold/ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  PLUGIN_FILTERS,
  PLUGIN_FILTER_LABELS,
  PLUGIN_SECTIONS,
  PLUGIN_SORTS,
  PLUGIN_SORT_LABELS,
  childrenOf,
  familySummary,
  parentOf,
  pluginCatalog,
  pluginCategoryKind,
  pluginRelations,
  publisherOf,
  type PluginCategoryKind,
  type PluginFamilyRow,
  type PluginFilter,
  type PluginSort,
} from "./catalog.ts";
import {
  PLUGIN_HALF_LABELS,
  PLUGIN_HALVES,
  appliedMismatch,
  dataVersionWords,
  dependencyChanges,
  expandingMembers,
  hasHalf,
  installRefusalWords,
  linkHost,
  listNames,
  permissionCount,
  permissionSummary,
  pluginPermissions,
  pluginStatus,
  reviewStaleness,
  updateConsent,
  updateOwnership,
  updatePermissions,
  updateRefusalWords,
  type DependencyChange,
  type PluginStatus,
} from "./status.ts";
import {
  dismissSeatSuggestions,
  initialSeatSuggestions,
  missingWorkspacePanelSeats,
  reconcileSeatSuggestions,
  suggestedWorkspacePanelSeats,
  workspacePanelSeats,
} from "./seat-discovery.ts";
import { MachineRuntime } from "./runtime.tsx";
import { CredentialReferences } from "./credential-references.tsx";

/**
 * Composition administration, rendered by the composition it administers (issue #239). The
 * list is the server's roster verbatim (`host.assembly.roster()`), so this section can never
 * disagree with what the workspace actually composed, and every lever is one of the ENGINE's
 * doors — `engine.plugins.setEnabled`, `purge`, `install`, `uninstall`, `setSetting`,
 * `reviewUpdate`, `applyUpdate` — so this plugin owns the UI and only the UI. Enablement is
 * workspace-GLOBAL and hot: flipping a toggle here changes what every principal's client
 * composes, and the new roster is pushed rather than polled (D4).
 *
 * THE SHAPE is one list in three collapsible sections (Installed, Built-in, Engine) with a
 * detail sheet beside it — master-detail inside one modal — because the roster is one ledger
 * and a reader's questions about a row ("what can it do", "why is it off", "what needs it")
 * are answered by the row, not by a second screen. A plugin FAMILY (ADR 0023: a parent and
 * the parts that require it) is one row with a chevron, the parts nested under it, the
 * parent's toggle being the family's. Status and permissions are chips in plain words,
 * read off `status.ts`; the sentences about dependencies that used to ride every row are
 * gone from the list and live in the sheet's Relations card, as links.
 *
 * WHAT THE RAIL SEES is one discreet row that opens the modal (issue #91): a rail row is
 * 240px wide and this is a whole administrative screen. The opener wears the shell's own
 * `.sidebar-opener` vocabulary so it is identical by construction to the key table's door
 * beside it, and its MARKS come from `ControlIcon`, never a lucide import of its own (#116).
 */

/**
 * Which section bands are folded, remembered on THIS device (REGISTRY.md §Device-local
 * register). Presentation of a list whose content is durable server state, exactly as the
 * index remembers which folders are open. Absent ≡ the engine folded, everything else open:
 * the engine's rows are the ones nobody can change.
 */
const COLLAPSED_KEY = "manifold:plugin-manager-collapsed";
const DEFAULT_COLLAPSED: readonly PluginCategoryKind[] = PLUGIN_SECTIONS.filter(
  (section) => section.collapsedByDefault,
).map((section) => section.kind);

function initialCollapsed(): ReadonlySet<PluginCategoryKind> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "null");
    if (!Array.isArray(stored)) return new Set(DEFAULT_COLLAPSED);
    const kinds = PLUGIN_SECTIONS.map((section) => section.kind).filter((kind) =>
      stored.includes(kind),
    );
    return new Set(kinds);
  } catch {
    return new Set(DEFAULT_COLLAPSED);
  }
}

function rememberCollapsed(collapsed: ReadonlySet<PluginCategoryKind>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Fold memory is optional: a device that cannot store it opens every band next time.
  }
}

/**
 * The high-risk caps the install door WITHHOLDS from a default grant (ADR 0016 §5; the
 * server's `UNGRANTED_BY_DEFAULT`, `docs/PLUGINS.md` §Installing a plugin). The form shows
 * each as a chip an installer may press to re-add: consent to a stranger's root authority is
 * a press with the word on it, never a comma the reader typed.
 */
const WITHHELD_BY_DEFAULT: readonly Cap[] = ["*", "tokens:mint", "plugins:manage"];

/**
 * The purge vocabulary, in a human's words. The KEYS are the protocol's closed target set,
 * so a fourth target cannot be added without this table refusing to compile — a destructive
 * verb whose UI silently omits one of the things it destroys is worse than no UI at all.
 */
const PURGE_TARGET_LABELS: Readonly<Record<PluginPurgeTarget, string>> = {
  storage: "stored data",
  elements: "element records",
  ownership: "element-type claims",
};

/**
 * What the manifest SAYS a purge of this plugin would cost, which is the whole reason
 * `purges` exists: audit visibility, read before the button is pressed and bound to no verb
 * (ADR 0013 §1). Silence is a real answer and is shown as one.
 */
function purgeDeclaration(entry: PluginRosterEntry): string {
  const declared = entry.manifest.purges ?? [];
  if (declared.length === 0) return "Declares nothing a purge would destroy";
  return `Purging drops ${declared.map((target) => PURGE_TARGET_LABELS[target]).join(", ")}`;
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What the install form hands the door, before the door grades it. */
interface InstallDraft {
  readonly source: string;
  readonly sha256: string;
  readonly grant: readonly Cap[];
  readonly hardened: boolean;
}

/** One chip: a word with a tone, and the sentence behind it on hover. */
function Chip({
  tone,
  title,
  testid,
  children,
}: {
  readonly tone?: PluginStatus["tone"] | "muted" | "publisher" | "update";
  readonly title?: string | undefined;
  readonly testid?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span className="plugin-manager-chip" data-tone={tone} title={title} data-testid={testid}>
      {children}
    </span>
  );
}

/**
 * THE ENABLEMENT TOGGLE, one component for every place it appears (a list row, a child row,
 * the family card), so `data-action`, the gate's test id and the "for everyone" tooltip are
 * written once. `reason` is why it is inert — the door's own refusal in words, or a missing
 * capability — and a toggle with a reason renders DISABLED with that reason on hover rather
 * than as a lock glyph: the shape a reader knows, saying why it will not move.
 */
function EnableToggle({
  entry,
  reason,
  pending,
  onToggle,
}: {
  readonly entry: PluginRosterEntry;
  readonly reason: string | null;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
}): ReactElement {
  const verb = entry.enabled ? "Turn off" : "Turn on";
  const attribution =
    typeof entry.changedBy === "string" ? ` · last changed by ${entry.changedBy}` : "";
  return (
    <button
      className="plugin-manager-toggle"
      type="button"
      role="switch"
      aria-checked={entry.enabled}
      aria-label={`${verb} ${entry.manifest.title}`}
      title={reason ?? `${verb} ${entry.manifest.title} for everyone${attribution}`}
      data-action={ENGINE_SET_ENABLED_ACTION}
      data-testid="plugin-manager-toggle"
      disabled={reason !== null || pending}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(!entry.enabled);
      }}
    >
      <span className="plugin-manager-toggle-knob" aria-hidden="true" />
    </button>
  );
}

/**
 * THE GENERIC SETTINGS PANE (#133): one control per DECLARED setting, and a named absence for
 * a plugin that declares none. Rendered from `host.assembly.settings` — the composed table,
 * effective values already applied — so this knows nothing about what any setting means, no
 * plugin registers a form, and a stranger's plugin gets the pane `core.canvas` gets by
 * declaring one line of manifest. Writes go to the engine's door and the table is RE-READ
 * (`refreshSettings`), never flipped locally: the value is stored per principal on the server,
 * so the switch showing "off" and the sidebar dropping a row are the same fact arriving from
 * the same place.
 */
function SettingsPane({
  settings,
  pluginTitle,
  pending,
  canManage,
  onSet,
}: {
  readonly settings: readonly ComposedSetting[];
  readonly pluginTitle: string;
  readonly pending: string | null;
  readonly canManage: boolean;
  readonly onSet: (setting: ComposedSetting, value: boolean | string) => void;
}): ReactElement {
  if (settings.length === 0) {
    return (
      <p className="plugin-manager-settings-empty" data-testid="plugin-manager-settings-empty">
        {pluginTitle} declares no settings.
      </p>
    );
  }
  return (
    <div className="plugin-manager-settings" data-testid="plugin-manager-settings">
      {settings.map((setting) => (
        <div className="plugin-manager-setting" key={setting.ref}>
          <span className="plugin-manager-setting-label">
            <strong>{setting.title}</strong>
            <small>
              {setting.scope === "workspace"
                ? "Workspace setting — shared by everyone"
                : "Your own preference"}
            </small>
            {setting.scope === "workspace" && !canManage ? (
              <small>plugins:manage capability required</small>
            ) : null}
            {setting.value === setting.declared ? null : (
              <small className="plugin-manager-setting-moved">Changed from default</small>
            )}
          </span>
          {setting.kind === "enum" ? (
            <select
              aria-label={setting.title}
              value={String(setting.value)}
              data-action={ENGINE_SET_SETTING_ACTION}
              data-setting={setting.ref}
              disabled={pending === setting.ref || (setting.scope === "workspace" && !canManage)}
              onChange={(event) => onSet(setting, event.target.value)}
            >
              {setting.values.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.title}
                </option>
              ))}
            </select>
          ) : (
            <button
              className="plugin-manager-setting-toggle"
              type="button"
              role="switch"
              aria-checked={setting.value === true}
              aria-label={`${setting.value ? "Turn off" : "Turn on"} ${setting.title}`}
              title={
                setting.scope === "workspace"
                  ? "Shared by everyone in this workspace"
                  : "Your own preference, on every device"
              }
              data-action={ENGINE_SET_SETTING_ACTION}
              data-testid="plugin-manager-setting-toggle"
              data-setting={setting.ref}
              disabled={pending === setting.ref || (setting.scope === "workspace" && !canManage)}
              onClick={() => onSet(setting, !setting.value)}
            >
              {setting.value ? "On" : "Off"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * THE INSTALL FORM (ADR 0016 §8 stage 2), inline in the Installed band. It asks for exactly
 * what the door asks for — where the artifact is, and the hash of its bytes — because consent
 * to run a stranger's code is consent to THESE bytes, and a form that fetched first and asked
 * later would have already decided. The grant review is the default subtraction made visible:
 * the three caps the door withholds are chips, off, and an installer who wants one presses
 * the word. A reader who presses nothing gets the safe answer, in writing.
 */
function InstallForm({
  busy,
  failure,
  onInstall,
  onDismiss,
}: {
  readonly busy: boolean;
  /** The last attempt's refusal, already in words (`installRefusalWords`). */
  readonly failure: string | null;
  readonly onInstall: (draft: InstallDraft) => void;
  readonly onDismiss: () => void;
}): ReactElement {
  const [source, setSource] = useState("");
  const [sha256, setSha256] = useState("");
  const [grant, setGrant] = useState<ReadonlySet<Cap>>(new Set());
  const [hardened, setHardened] = useState(false);
  const ready = source.trim().length > 0 && /^[0-9a-f]{64}$/i.test(sha256.trim());
  return (
    <form
      className="plugin-manager-install"
      data-testid="plugin-manager-install-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onInstall({
          source: source.trim(),
          sha256: sha256.trim().toLowerCase(),
          grant: WITHHELD_BY_DEFAULT.filter((cap) => grant.has(cap)),
          hardened,
        });
      }}
    >
      <label className="plugin-manager-install-field">
        <span>Source — an https:// URL, or a path under the server's plugin-uploads box</span>
        <input
          className="plugin-manager-search"
          type="text"
          value={source}
          placeholder="https://example.org/vendor.sample.manifold-plugin.json"
          spellCheck={false}
          autoFocus
          disabled={busy}
          data-testid="plugin-manager-install-source"
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <label className="plugin-manager-install-field">
        <span>SHA-256 of the bundle's exact bytes — what you are consenting to run</span>
        <input
          className="plugin-manager-search"
          type="text"
          value={sha256}
          placeholder="64 hex characters"
          spellCheck={false}
          disabled={busy}
          data-testid="plugin-manager-install-sha256"
          onChange={(event) => setSha256(event.target.value)}
        />
      </label>
      <label className="plugin-manager-install-field">
        <span>
          <input
            type="checkbox"
            checked={hardened}
            disabled={busy}
            onChange={(event) => setHardened(event.target.checked)}
          />{" "}
          Run hardened — requires a self-contained hardened bundle
        </span>
        <small>
          Otherwise runs in-realm with React and the full engine API. Only install code you trust.
        </small>
      </label>
      <div className="plugin-manager-install-field">
        <span>
          Grant — the default withholds these three from whatever the bundle declares; press one to
          grant it anyway
        </span>
        <div className="plugin-manager-install-grant" role="group" aria-label="Grant review">
          {WITHHELD_BY_DEFAULT.map((cap) => (
            <button
              key={cap}
              className="plugin-manager-filter"
              type="button"
              aria-pressed={grant.has(cap)}
              title={grant.has(cap) ? `Granted: ${cap}` : `Withheld by default: ${cap}`}
              disabled={busy}
              data-testid="plugin-manager-install-grant"
              data-cap={cap}
              onClick={() =>
                setGrant((current) => {
                  const next = new Set(current);
                  if (next.has(cap)) next.delete(cap);
                  else next.add(cap);
                  return next;
                })
              }
            >
              {grant.has(cap) ? "granted" : "withheld"} {cap}
            </button>
          ))}
        </div>
      </div>
      <div className="plugin-manager-install-actions">
        <button
          className="plugin-manager-filter"
          type="submit"
          data-action={ENGINE_INSTALL_ACTION}
          data-testid="plugin-manager-install"
          title="Install this bundle for everyone in the workspace"
          disabled={busy || !ready}
        >
          {busy ? "Installing…" : "Install"}
        </button>
        <button
          className="plugin-manager-filter"
          type="button"
          data-testid="plugin-manager-install-cancel"
          onClick={onDismiss}
        >
          Cancel
        </button>
      </div>
      {failure === null ? null : (
        <p
          className="plugin-manager-error"
          data-testid="plugin-manager-install-failure"
          role="alert"
        >
          {failure}
        </p>
      )}
    </form>
  );
}

/** A named plugin as a JUMP to its own row, never prose: the reason to read a relation is to go look. */
function PluginLink({
  id,
  pluginTitle,
  onSelect,
}: {
  readonly id: string;
  readonly pluginTitle: (id: string) => string;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  return (
    <button
      className="plugin-manager-dep-link"
      type="button"
      title={id}
      aria-label={`Show ${pluginTitle(id)}`}
      onClick={() => onSelect(id)}
    >
      {pluginTitle(id)}
    </button>
  );
}

/** One card of the detail sheet: a heading and whatever the card lists. */
function SheetCard({
  title,
  testid,
  children,
}: {
  readonly title: string;
  readonly testid?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="plugin-manager-sheet-card" data-testid={testid}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** A contribution kind's list, rendered only when the manifest declares any of it. */
function ContributedKind({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly { readonly id: string; readonly title: string }[];
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="plugin-manager-contributes">
      <span>{label}</span>
      <ul>
        {items.map((item) => (
          <li key={item.id} title={item.id}>
            {item.title} <small>{item.id}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The hub's last observation of a family's release source, in words (#238). */
function updateStatusWords(status: PluginUpdateStatus | undefined): string {
  if (status === undefined) return "Not checked yet.";
  switch (status.state) {
    case "unchecked":
      return "Not checked yet.";
    case "checking":
      return "Checking the release source now.";
    case "current":
      return `Current: the release source's preferred release is what is installed (checked ${WHEN.format(status.checkedAt)}).`;
    case "available":
      return `${status.version} is available for ${listNames(status.family)} (found ${WHEN.format(status.checkedAt)}). Nothing installs until it is reviewed and applied.`;
    case "failed":
      return `The last check failed (${WHEN.format(status.checkedAt)}): ${status.message}`;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * WHAT A BUNDLE WAS BUILT AGAINST beside what this hub runs (ADR 0025 §Consequences b), per
 * component: both versions and whether the mismatch is known or merely unrecorded. Unknown is
 * legacy metadata and loads as it always did; a known mismatch is the server's to hold.
 */
function CompatibilityIssues({
  compatibility,
}: {
  readonly compatibility: PluginBuildCompatibility;
}): ReactElement {
  return (
    <div className="plugin-manager-update-compatibility" data-status={compatibility.status}>
      <p>
        {compatibility.status === "compatible"
          ? "Built against what this hub runs."
          : compatibility.status === "unknown"
            ? "Build compatibility cannot be verified from this bundle's metadata."
            : "Built against something this hub does not run."}
      </p>
      {compatibility.issues.length === 0 ? null : (
        <ul>
          {compatibility.issues.map((issue) => (
            <li key={issue.component} data-kind={issue.kind}>
              <code>{issue.component}</code> built against {issue.built ?? "an unrecorded version"};
              this hub runs {issue.current}
              {issue.kind === "incompatible" ? " — incompatible" : " — not verifiable"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * THE UPDATES CARD (#238): who owns this row's next version and, for an installed bundle
 * family whose root declares a release source, the hub's last observation of it and the one
 * door that reviews it. A part routes to its family's root, because the whole installed family
 * is reviewed and applied together. Everything else names its real owner and offers no button:
 * a compiled seat rides the Manifold release it was proven with, and an unpacked row belongs to
 * its source tree. Reviewing is root-only — it admits a stranger's code — so `plugins:manage`
 * sees the observation and the sentence, never the door.
 */
function UpdatesCard({
  entry,
  roster,
  canInstall,
  busy,
  pluginTitle,
  onSelect,
  onReviewUpdate,
}: {
  readonly entry: PluginRosterEntry;
  readonly roster: readonly PluginRosterEntry[];
  readonly canInstall: boolean;
  readonly busy: boolean;
  readonly pluginTitle: (id: string) => string;
  readonly onSelect: (id: string) => void;
  readonly onReviewUpdate: (rootId: string) => void;
}): ReactElement {
  const ownership = updateOwnership(roster, entry);
  const compatibility = entry.install?.compatibility;
  let body: ReactElement;
  switch (ownership.kind) {
    case "engine":
      body = (
        <p className="plugin-manager-sheet-muted">
          An engine door: it changes only when Manifold itself is upgraded.
        </p>
      );
      break;
    case "build":
      body = (
        <p className="plugin-manager-sheet-muted">
          Compiled into this Manifold build and released with it: it changes only when Manifold is
          upgraded, never on its own.
        </p>
      );
      break;
    case "unpacked": {
      const rootId = ownership.root.manifest.id;
      body =
        rootId === entry.manifest.id ? (
          <p className="plugin-manager-relation">
            Unpacked: this hub rebuilds it from <code>{`<data>/authored/${rootId}/`}</code> on every
            save. That source tree is the only way to change it; no release source replaces it.
          </p>
        ) : (
          <p className="plugin-manager-relation">
            Its family root <PluginLink id={rootId} pluginTitle={pluginTitle} onSelect={onSelect} />{" "}
            is unpacked: that source tree owns the family, so no release source updates it.
          </p>
        );
      break;
    }
    case "unsourced": {
      const rootId = ownership.root.manifest.id;
      body =
        rootId === entry.manifest.id ? (
          <p className="plugin-manager-sheet-muted">
            Declares no release source, so the hub never checks for a newer version and no update is
            offered here.
          </p>
        ) : (
          <p className="plugin-manager-relation">
            Part of the installed family{" "}
            <PluginLink id={rootId} pluginTitle={pluginTitle} onSelect={onSelect} />, which declares
            no release source: no update is checked for or offered.
          </p>
        );
      break;
    }
    case "feed": {
      const rootId = ownership.root.manifest.id;
      const status = entry.install?.update ?? ownership.root.install?.update;
      body = (
        <>
          {rootId === entry.manifest.id ? null : (
            <p className="plugin-manager-relation">
              Updated with its family:{" "}
              <PluginLink id={rootId} pluginTitle={pluginTitle} onSelect={onSelect} /> reviews and
              applies every installed part together.
            </p>
          )}
          <p className="plugin-manager-update-source">
            Release source <code title={ownership.source}>{ownership.source}</code>
          </p>
          <p className="plugin-manager-update-status" data-state={status?.state ?? "unchecked"}>
            {updateStatusWords(status)}
          </p>
          {canInstall ? (
            <div>
              <button
                className="plugin-manager-filter"
                type="button"
                data-action={ENGINE_REVIEW_UPDATE_ACTION}
                data-plugin={rootId}
                title={`Fetch and verify the preferred release of ${pluginTitle(rootId)}, then show exactly what it changes for the whole family. Nothing installs until you apply it.`}
                disabled={busy}
                onClick={() => onReviewUpdate(rootId)}
              >
                {status?.state === "available"
                  ? `Review the ${status.version} update`
                  : "Check and review"}
              </button>
            </div>
          ) : (
            <p className="plugin-manager-sheet-muted">
              Reviewing and applying an update admits new code, so it needs the root capability —
              plugins:manage is not enough.
            </p>
          )}
        </>
      );
      break;
    }
    default: {
      const exhaustive: never = ownership;
      return exhaustive;
    }
  }
  return (
    <SheetCard title="Updates">
      {body}
      {compatibility === undefined ? null : <CompatibilityIssues compatibility={compatibility} />}
    </SheetCard>
  );
}

/** A declared relationship's change between the installed and the candidate manifest. */
function dependencyChangeWords({ before, after }: DependencyChange): string {
  const reason = after?.reason === undefined ? "" : ` (“${after.reason}”)`;
  if (after === null) return `dropped — was ${before?.type ?? "declared"}`;
  if (before === null) return `new — ${after.type}${reason}`;
  if (before.type === after.type) return `${after.type}, with a new reason${reason}`;
  return `${before.type} → ${after.type}${reason}`;
}

/**
 * ONE PART OF THE FAMILY, as the review describes it: exact pins, what its capability ceiling
 * gains and loses with the grant it would hold afterwards, its relationships, its halves, its
 * stored data against the version the candidate declares, the compatibility of its build, and
 * its changelog as TEXT — React escapes it, so a publisher's markup is shown, never run.
 */
function UpdateMemberReview({
  member,
  isRoot,
  acknowledged,
  disabled,
  onAcknowledge,
}: {
  readonly member: PluginUpdateMember;
  readonly isRoot: boolean;
  readonly acknowledged: boolean;
  readonly disabled: boolean;
  readonly onAcknowledge: (acknowledged: boolean) => void;
}): ReactElement {
  const { current, candidate } = member;
  const unchanged = current !== null && current.sha256 === candidate.sha256;
  /** Same bytes and nothing to consent to or migrate: the part is named, not re-described. */
  const settled =
    unchanged &&
    member.capabilitiesAdded.length === 0 &&
    member.capabilitiesRemoved.length === 0 &&
    !member.migrationRequired;
  const headingId = `plugin-manager-update-member-${member.id}`;
  const permissions = updatePermissions(member);
  const added = member.capabilitiesAdded;
  const addedGoverned = added.filter((cap) => GOVERNED_CAPS.includes(cap));
  const dependencies = dependencyChanges(current?.dependencies ?? null, candidate.dependencies);
  const halves = PLUGIN_HALVES.flatMap((half) => {
    const before = current !== null && hasHalf(current, half);
    const after = hasHalf(candidate, half);
    if (!before && !after) return [];
    const change =
      current === null ? "included" : before === after ? "kept" : after ? "added" : "removed";
    return [{ half, change }];
  });
  const stored = member.storedDataVersion;
  const declared = candidate.dataVersion;
  return (
    <section
      className="plugin-manager-update-member"
      aria-labelledby={headingId}
      data-plugin={member.id}
    >
      <header className="plugin-manager-update-member-head">
        <div>
          <h4 id={headingId}>{member.title}</h4>
          <small>{member.id}</small>
        </div>
        <Cluster gap="0.3rem">
          {isRoot ? <Chip tone="muted">Family root</Chip> : null}
          {current === null ? (
            <Chip tone="update" title="Not installed yet: this release adds it to the family">
              New part
            </Chip>
          ) : unchanged ? (
            <Chip tone="muted" title="The candidate is the same bytes as the installed pin">
              Unchanged
            </Chip>
          ) : (
            <Chip tone="update" title="The installed pin is replaced">
              Replaced
            </Chip>
          )}
          <Chip
            tone="muted"
            title={
              member.hardened
                ? "Keeps running in a separate process and browser Worker"
                : "Keeps running with React and the full engine API"
            }
          >
            {member.hardened ? "Hardened" : "In-realm"}
          </Chip>
        </Cluster>
      </header>
      <dl className="plugin-manager-update-facts">
        <dt>Version</dt>
        <dd>
          {current === null
            ? `${candidate.version} (new)`
            : unchanged
              ? `${candidate.version} (same bytes)`
              : `${current.version} → ${candidate.version}`}
        </dd>
        <dt>Pin</dt>
        <dd>
          {current === null || unchanged ? null : (
            <>
              <code title={current.sha256}>{current.sha256.slice(0, 12)}</code> →{" "}
            </>
          )}
          <code title={candidate.sha256}>{candidate.sha256.slice(0, 12)}</code>
        </dd>
        <dt>From</dt>
        <dd>
          <code title={candidate.source}>{candidate.source}</code>
          {current === null || current.source === candidate.source ? null : (
            <>
              {" "}
              (was <code title={current.source}>{current.source}</code>)
            </>
          )}
        </dd>
        <dt>State</dt>
        <dd>
          {current === null
            ? `New; requested ${member.enabled ? "on" : "off"} after installation`
            : unchanged
              ? `${current.enabled ? "On" : "Off"}; not replaced`
              : !member.enabled
                ? "Off; stays off"
                : `${current.enabled ? "On" : "Off (held)"}; requested on after update`}
        </dd>
      </dl>
      {settled ? (
        <>
          <p className="plugin-manager-sheet-muted">
            Same bytes as installed: nothing about this part changes.
          </p>
          {member.compatibility.status === "compatible" ? null : (
            <CompatibilityIssues compatibility={member.compatibility} />
          )}
        </>
      ) : (
        <>
          <div className="plugin-manager-update-block">
            <h5>Capabilities</h5>
            {added.length === 0 && member.capabilitiesRemoved.length === 0 ? (
              <p>Its capability ceiling does not change.</p>
            ) : null}
            {member.capabilitiesRemoved.length === 0 ? null : (
              <p>
                No longer declares{" "}
                {member.capabilitiesRemoved.map((cap, index) => (
                  <span key={cap}>
                    {index === 0 ? "" : ", "}
                    <code>{cap}</code>
                  </span>
                ))}
                : its grant narrows with its ceiling.
              </p>
            )}
            {permissions.length === 0 ? (
              <p>The candidate declares no capabilities.</p>
            ) : (
              <>
                <p className="plugin-manager-sheet-muted">
                  {added.length === 0
                    ? "What it holds after this update:"
                    : "What it holds after this update, once the new capabilities are acknowledged:"}
                </p>
                <ul className="plugin-manager-permissions">
                  {permissions.map((permission) => (
                    <li
                      key={permission.cap}
                      className={`plugin-manager-permission${
                        permission.state === "granted" ? "" : ` is-${permission.state}`
                      }${permission.added ? " is-added" : ""}`}
                      title={
                        permission.state === "withheld"
                          ? "Declared, but not in its grant after this update"
                          : permission.state === "governed"
                            ? "Governed: no grant ever carries this one. It is discharged per node, bound to an artifact revision, by consent."
                            : undefined
                      }
                    >
                      <code>{permission.cap}</code>
                      <span>{permission.meaning}</span>
                      {permission.added || permission.state !== "granted" ? (
                        <small>
                          {[
                            permission.added ? "new" : null,
                            permission.state === "granted" ? null : permission.state,
                          ]
                            .filter((word) => word !== null)
                            .join(" · ")}
                        </small>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="plugin-manager-sheet-muted">
                  Ordinary grant after this update: {listNames(member.grantedCaps) || "none"}.
                  Previously withheld authority stays withheld; governed capabilities still require
                  separate per-node consent.
                </p>
              </>
            )}
            {added.length === 0 ? null : (
              <label className="plugin-manager-update-consent">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={disabled}
                  data-plugin={member.id}
                  onChange={(event) => onAcknowledge(event.target.checked)}
                />
                <span>
                  I acknowledge that {member.title}'s capability ceiling grows by {listNames(added)}
                  {addedGoverned.length === 0
                    ? "."
                    : `; ${listNames(addedGoverned)} ${addedGoverned.length === 1 ? "stays" : "stay"} governed, consented per node and never granted.`}
                </span>
              </label>
            )}
          </div>
          <div className="plugin-manager-update-block">
            <h5>Dependencies</h5>
            {dependencies.length === 0 ? (
              <p>No change to what it requires, uses or refuses.</p>
            ) : (
              <ul>
                {dependencies.map((change) => (
                  <li key={change.id}>
                    <code>{change.id}</code> {dependencyChangeWords(change)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="plugin-manager-update-block">
            <h5>Halves</h5>
            <ul>
              {halves.map(({ half, change }) => (
                <li key={half} data-change={change}>
                  {PLUGIN_HALF_LABELS[half]}: {change}
                </li>
              ))}
            </ul>
          </div>
          <div className="plugin-manager-update-block">
            <h5>Data</h5>
            <p>
              {stored === null
                ? "No stored data version"
                : `Stored data ${dataVersionWords(stored)}`}
              {" · "}
              {declared === null
                ? "the candidate declares no data version"
                : `the candidate declares ${dataVersionWords(declared)}`}
            </p>
            <p data-migration={member.migrationRequired}>
              {member.migrationRequired
                ? "Its stored data is migrated when this update is applied."
                : "No data migration is needed."}
            </p>
          </div>
          <div className="plugin-manager-update-block">
            <h5>Compatibility</h5>
            <CompatibilityIssues compatibility={member.compatibility} />
          </div>
          <div className="plugin-manager-update-block">
            <h5>Changelog</h5>
            {member.changelog === null ? (
              <p>No changelog: the bundle packs no CHANGELOG.md and declares no changelog link.</p>
            ) : (
              <>
                <small>
                  From <code title={member.changelog.source}>{member.changelog.source}</code>
                </small>
                {member.changelog.text.trim() === "" ? (
                  <p>The changelog is empty.</p>
                ) : (
                  <pre
                    className="plugin-manager-update-changelog"
                    tabIndex={0}
                    aria-label={`Changelog of ${member.title}`}
                  >
                    {member.changelog.text}
                  </pre>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** A review the hub answered, with the local instant it stops being usable. */
interface HeldReview {
  readonly review: PluginUpdateReview;
  /**
   * The server's lifetime for the review, counted from when the REQUEST left: a slow answer
   * can only shorten the window this client offers, never stretch it past the server's.
   */
  readonly deadline: number;
}

/** One open update review: the family asked about, and where the conversation stands. */
interface UpdateSession {
  readonly rootId: string;
  readonly phase: "review" | "apply" | null;
  readonly held: HeldReview | null;
  /** The hub's "nothing newer" answer, with the root it resolved. */
  readonly current: { readonly rootId: string; readonly checkedAt: number } | null;
  /** The expanding members whose new capabilities the reader has acknowledged. */
  readonly acknowledged: ReadonlySet<string>;
  /** The last request's own failure, in words. */
  readonly failure: string | null;
  /** Why a held review was dropped without a request: it expired, or the family moved. */
  readonly cleared: string | null;
}

const UNUSABLE = { held: null, acknowledged: new Set<string>() } as const;

/**
 * THE UPDATE CONVERSATION (#238), held at section level beside the other doors' pending
 * state: review a family, acknowledge exactly what it expands, apply exactly that review.
 *
 * A review is only offered while it is usable. It is DROPPED — never quietly kept — when its
 * lifetime runs out or the published roster shows the family moved (`reviewStaleness`), and
 * after ANY failed apply, because the hub holds one digest and a refusal or a lost answer
 * leaves nothing this client may assume about it; the reader is offered a fresh review
 * instead. Nothing is written to the roster here: an applied update arrives on the next
 * `plugins` frame like every other install, and the notice repeats only the hub's own record,
 * checked against the review it answered.
 *
 * `ticket` retires an answer whose conversation was closed or restarted, so a late review can
 * never repopulate a dialog the reader dismissed.
 */
function useUpdateReview({
  host,
  roster,
  canInstall,
  holdPending,
  onApplied,
}: {
  readonly host: SectionProps["host"];
  readonly roster: readonly PluginRosterEntry[];
  readonly canInstall: boolean;
  readonly holdPending: (ids: readonly string[], held: boolean) => void;
  readonly onApplied: (rootId: string, notice: string) => void;
}) {
  const [session, setSession] = useState<UpdateSession | null>(null);
  const ticket = useRef(0);
  /** Set synchronously on the apply press, before React re-renders the button disabled. */
  const applying = useRef(false);
  const patch = (at: number, change: Partial<UpdateSession>): void => {
    if (ticket.current !== at) return;
    setSession((current) => (current === null ? null : { ...current, ...change }));
  };

  const held = session?.held ?? null;
  if (session !== null && held !== null && session.phase !== "apply") {
    const stale = reviewStaleness(roster, held.review);
    if (stale.length > 0) {
      setSession({
        ...session,
        ...UNUSABLE,
        cleared: `The installed family changed since this review: ${stale.join("; ")}. It no longer describes what is installed, so it was cleared — review again for a current answer.`,
      });
    }
  }

  const deadline = held?.deadline ?? null;
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setTimeout(
      () => {
        setSession((current) =>
          current === null || current.held?.deadline !== deadline || current.phase === "apply"
            ? current
            : {
                ...current,
                ...UNUSABLE,
                cleared: `This review expired at ${WHEN.format(deadline)}. Review again for a current answer.`,
              },
        );
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [deadline]);

  const review = async (rootId: string): Promise<void> => {
    if (!canInstall || session?.phase === "apply") return;
    ticket.current += 1;
    const at = ticket.current;
    const sentAt = Date.now();
    setSession({
      rootId,
      phase: "review",
      held: null,
      current: null,
      acknowledged: new Set(),
      failure: null,
      cleared: null,
    });
    holdPending([ENGINE_REVIEW_UPDATE_ACTION], true);
    try {
      const outcome = await host.client.action(ENGINE_REVIEW_UPDATE_ACTION, { id: rootId });
      if (!outcome.ok) {
        patch(at, {
          failure: `${updateRefusalWords(outcome.denial.message)}. Nothing was installed.`,
        });
        return;
      }
      const parsed = PluginUpdateReviewResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        patch(at, {
          failure: "The hub answered, but its review could not be read. Nothing was installed.",
        });
        return;
      }
      const answer = parsed.data;
      if (answer.state === "current") {
        patch(at, { current: { rootId: answer.rootId, checkedAt: answer.checkedAt } });
        return;
      }
      const lifetime = Math.max(0, answer.review.expiresAt - answer.review.createdAt);
      patch(at, { held: { review: answer.review, deadline: sentAt + lifetime } });
    } catch (reason: unknown) {
      patch(at, {
        failure: `${reason instanceof Error ? reason.message : "Could not review the update"}. Nothing was installed.`,
      });
    } finally {
      patch(at, { phase: null });
      if (ticket.current === at) holdPending([ENGINE_REVIEW_UPDATE_ACTION], false);
    }
  };

  const apply = async (): Promise<void> => {
    if (
      applying.current ||
      session === null ||
      session.phase !== null ||
      session.held === null ||
      !canInstall
    ) {
      return;
    }
    const { review: reviewed, deadline: until } = session.held;
    const consent = updateConsent(reviewed, session.acknowledged);
    if (reviewed.blockers.length > 0 || consent === null) return;
    if (Date.now() >= until) {
      setSession({
        ...session,
        ...UNUSABLE,
        cleared: `This review expired at ${WHEN.format(until)}. Review again for a current answer.`,
      });
      return;
    }
    applying.current = true;
    const at = ticket.current;
    const pendingKeys = [
      ENGINE_APPLY_UPDATE_ACTION,
      ...reviewed.members.map((member) => member.id),
    ];
    setSession({ ...session, phase: "apply", failure: null, cleared: null });
    holdPending(pendingKeys, true);
    try {
      const outcome = await host.client.action(ENGINE_APPLY_UPDATE_ACTION, {
        digest: reviewed.digest,
        consent,
      });
      if (!outcome.ok) {
        patch(at, {
          ...UNUSABLE,
          failure: `${updateRefusalWords(outcome.denial.message)}. This review can no longer be applied; the list shows what is installed now.`,
        });
        return;
      }
      const parsed = PluginUpdateApplyResultSchema.safeParse(outcome.result);
      const mismatch = parsed.success
        ? appliedMismatch(reviewed, parsed.data)
        : "its record could not be read";
      if (!parsed.success || mismatch !== null) {
        patch(at, {
          ...UNUSABLE,
          failure: `The hub accepted the update, but ${mismatch ?? "its record could not be read"}. Check the list for what is installed now before reviewing again.`,
        });
        return;
      }
      ticket.current += 1;
      setSession(null);
      onApplied(
        reviewed.rootId,
        `Updated the ${reviewed.rootId} family to exactly the reviewed bytes — ${parsed.data.installed
          .map((installed) => `${installed.id} ${installed.version}`)
          .join(", ")}`,
      );
    } catch (reason: unknown) {
      patch(at, {
        ...UNUSABLE,
        failure: `${reason instanceof Error ? reason.message : "Could not apply the update"}. The outcome is unknown: do not assume it did or did not apply. The list shows what is installed; review again before retrying.`,
      });
    } finally {
      applying.current = false;
      patch(at, { phase: null });
      holdPending(pendingKeys, false);
    }
  };

  /** Dismiss the conversation; refused while an apply is in flight, whose answer must be read. */
  const close = (): boolean => {
    if (applying.current || session?.phase === "apply") return false;
    ticket.current += 1;
    holdPending([ENGINE_REVIEW_UPDATE_ACTION], false);
    setSession(null);
    return true;
  };

  const acknowledge = (id: string, on: boolean): void => {
    setSession((current) => {
      if (current === null || current.phase !== null || current.held === null) return current;
      const next = new Set(current.acknowledged);
      if (on) next.add(id);
      else next.delete(id);
      return { ...current, acknowledged: next };
    });
  };

  return { session, review, apply, close, acknowledge };
}

/**
 * THE REVIEW DIALOG: a modal over the manager, because consent to new code is a moment that
 * owns the screen until it is answered. Escape and the backdrop dismiss it — except while an
 * apply is in flight, when the hub's answer is the one thing the reader must see. Focus lands
 * on the title while the hub works, on the review's summary when one arrives, and on "Review
 * again" when a review is dropped or refused; the section returns it to the opener on close.
 */
function UpdateReviewDialog({
  session,
  canInstall,
  pluginTitle,
  onReview,
  onApply,
  onAcknowledge,
  onClose,
}: {
  readonly session: UpdateSession;
  readonly canInstall: boolean;
  readonly pluginTitle: (id: string) => string;
  readonly onReview: () => void;
  readonly onApply: () => void;
  readonly onAcknowledge: (id: string, acknowledged: boolean) => void;
  readonly onClose: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const againRef = useRef<HTMLButtonElement | null>(null);
  const { phase, held, current, acknowledged, failure, cleared } = session;
  const review = held?.review ?? null;
  const familyId = review?.rootId ?? current?.rootId ?? session.rootId;
  const digest = review?.digest ?? null;
  const settledKey =
    phase === null && review === null && (failure !== null || cleared !== null)
      ? `${failure ?? ""}\n${cleared ?? ""}`
      : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    if (phase !== null) titleRef.current?.focus();
  }, [phase]);
  useEffect(() => {
    if (digest !== null) summaryRef.current?.focus();
  }, [digest]);
  useEffect(() => {
    if (settledKey !== null) againRef.current?.focus();
  }, [settledKey]);

  const members = review?.members ?? [];
  const fresh = members.filter((member) => member.current === null);
  const unchanged = members.filter(
    (member) => member.current !== null && member.current.sha256 === member.candidate.sha256,
  ).length;
  const replaced = members.length - fresh.length - unchanged;
  const unacknowledged =
    review === null
      ? []
      : expandingMembers(review).filter((member) => !acknowledged.has(member.id));
  const gate = !canInstall
    ? "Reviewing and applying an update needs the root capability."
    : review === null
      ? null
      : review.blockers.length > 0
        ? "Blocked: this review cannot be applied."
        : unacknowledged.length > 0
          ? `Acknowledge the new capabilities of ${listNames(unacknowledged.map((member) => member.title))} to apply.`
          : null;
  const state =
    phase === "review"
      ? "Fetching the release source and verifying the candidate bytes. A review installs nothing and runs none of the candidate's code."
      : phase === "apply"
        ? "Applying the reviewed update to the whole family. Keep this open for the hub's answer."
        : current !== null
          ? `Current: the preferred release of ${current.rootId} is what is installed (checked ${WHEN.format(current.checkedAt)}). There is nothing to apply.`
          : review !== null
            ? "Nothing has changed yet. Read what this update does, then apply it or cancel."
            : "No review is held.";

  return (
    <dialog
      ref={dialogRef}
      className="plugin-manager-update-dialog"
      aria-labelledby="plugin-manager-update-title"
      aria-describedby="plugin-manager-update-state"
      aria-busy={phase !== null}
      onCancel={(event) => {
        // The manager's own dialog retreats on Escape too; this one answers it alone.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClose={() => {
        // A browser may close a modal despite a cancelled Escape (its close-watcher rules): the
        // conversation follows the element instead of lingering unseen — unless an apply is in
        // flight, whose answer still has to be read.
        if (phase === "apply") dialogRef.current?.showModal();
        else onClose();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="plugin-manager-update-card">
        <header>
          <div>
            <span>Update review</span>
            <h3 id="plugin-manager-update-title" ref={titleRef} tabIndex={-1}>
              {pluginTitle(familyId)} family
            </h3>
            <small>{familyId}</small>
          </div>
          <button
            type="button"
            aria-label="Close the update review"
            title={
              phase === "apply"
                ? "The update is being applied; wait for the hub's answer"
                : "Close without applying anything"
            }
            disabled={phase === "apply"}
            onClick={onClose}
          >
            <ControlIcon kind="close" />
          </button>
        </header>
        <div
          className="plugin-manager-update-body"
          tabIndex={0}
          role="region"
          aria-label="What this update changes"
        >
          <p id="plugin-manager-update-state" className="plugin-manager-update-state" role="status">
            {state}
          </p>
          {failure === null ? null : (
            <p className="plugin-manager-error" role="alert">
              {failure}
            </p>
          )}
          {cleared === null ? null : (
            <p className="plugin-manager-update-cleared" role="status">
              {cleared}
            </p>
          )}
          {review === null || held === null ? null : (
            <>
              <div
                ref={summaryRef}
                tabIndex={-1}
                className="plugin-manager-update-summary"
                role="group"
                aria-label="Review summary"
              >
                <p>
                  <strong>
                    The whole family is reviewed and applied together: {String(members.length)}{" "}
                    {members.length === 1 ? "part" : "parts"}
                  </strong>
                  {" — "}
                  {[
                    replaced === 0 ? null : `${String(replaced)} replaced`,
                    fresh.length === 0 ? null : `${String(fresh.length)} new`,
                    unchanged === 0 ? null : `${String(unchanged)} unchanged`,
                  ]
                    .filter((count) => count !== null)
                    .join(", ")}
                  .
                </p>
                {fresh.length === 0 ? null : (
                  <p>
                    New parts this release adds, installed with the family:{" "}
                    {listNames(fresh.map((member) => member.id))}.
                  </p>
                )}
                <p className="plugin-manager-sheet-muted">
                  Verified against the release source; none of the candidate code has run. Review{" "}
                  <code title={review.digest}>{review.digest.slice(0, 12)}</code> · usable until{" "}
                  {WHEN.format(held.deadline)}.
                </p>
                {review.blockers.length === 0 ? null : (
                  <div className="plugin-manager-update-blockers" role="alert">
                    <strong>Blocked — nothing from this review can be applied:</strong>
                    <ul>
                      {review.blockers.map((blocker, index) => (
                        <li key={index}>
                          <code>{blocker.id}</code> {blocker.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {members.map((member) => (
                <UpdateMemberReview
                  key={member.id}
                  member={member}
                  isRoot={member.id === review.rootId}
                  acknowledged={acknowledged.has(member.id)}
                  disabled={phase !== null}
                  onAcknowledge={(on) => onAcknowledge(member.id, on)}
                />
              ))}
            </>
          )}
        </div>
        <footer className="plugin-manager-update-actions">
          {gate === null ? null : (
            <p id="plugin-manager-update-gate" className="plugin-manager-sheet-muted">
              {gate}
            </p>
          )}
          {review === null ? null : (
            <button
              className="plugin-manager-filter plugin-manager-update-primary"
              type="button"
              data-action={ENGINE_APPLY_UPDATE_ACTION}
              aria-describedby={gate === null ? undefined : "plugin-manager-update-gate"}
              disabled={gate !== null || phase !== null}
              onClick={onApply}
            >
              {phase === "apply"
                ? "Applying…"
                : `Apply to ${String(members.length)} ${members.length === 1 ? "part" : "parts"}`}
            </button>
          )}
          <button
            ref={againRef}
            className="plugin-manager-filter"
            type="button"
            data-action={ENGINE_REVIEW_UPDATE_ACTION}
            disabled={phase !== null || !canInstall}
            onClick={onReview}
          >
            {phase === "review" ? "Reviewing…" : current !== null ? "Check again" : "Review again"}
          </button>
          <button
            className="plugin-manager-filter"
            type="button"
            disabled={phase === "apply"}
            onClick={onClose}
          >
            {review === null ? "Close" : "Cancel"}
          </button>
        </footer>
      </section>
    </dialog>
  );
}

/**
 * THE DETAIL SHEET: roster declarations and composed settings, with machine installation
 * and consent read separately through the public jobs door for the selected machine.
 */
function PluginDetail({
  host,
  entry,
  roster,
  settings,
  canManage,
  canInstall,
  pendingIds,
  pendingSetting,
  armed,
  layout,
  onSeatPanels,
  pluginTitle,
  onSelect,
  onBack,
  onToggle,
  onArm,
  onPurge,
  onUninstall,
  onSet,
  onReviewUpdate,
}: {
  readonly host: SectionProps["host"];
  readonly entry: PluginRosterEntry;
  readonly roster: readonly PluginRosterEntry[];
  readonly settings: readonly ComposedSetting[];
  readonly canManage: boolean;
  readonly canInstall: boolean;
  readonly pendingIds: ReadonlySet<string>;
  readonly pendingSetting: string | null;
  readonly layout: TileLayout | null;
  readonly armed: boolean;
  readonly pluginTitle: (id: string) => string;
  readonly onSelect: (id: string) => void;
  readonly onBack: () => void;
  readonly onToggle: (target: PluginRosterEntry, enabled: boolean) => void;
  readonly onArm: (armed: boolean) => void;
  readonly onPurge: () => void;
  readonly onUninstall: () => void;
  readonly onSeatPanels: (panelIds: readonly string[]) => void;
  readonly onSet: (setting: ComposedSetting, value: boolean | string) => void;
  readonly onReviewUpdate: (rootId: string) => void;
}): ReactElement {
  const { manifest } = entry;
  const status = pluginStatus(roster, entry);
  const permissions = pluginPermissions(entry);
  const links = manifest.links;
  const parentId = parentOf(roster, entry);
  const children = childrenOf(roster, manifest.id);
  const relations = pluginRelations(roster, manifest.id);
  const requires = relations.requires.filter((id) => id !== parentId);
  const requiredBy = relations.requiredBy.filter(
    (id) => !children.some((child) => child.manifest.id === id),
  );
  const [copied, setCopied] = useState(false);
  const declared = settings.filter((setting) => setting.plugin === manifest.id);
  const contributes = manifest.contributes;
  const purgeable = canManage && !entry.enabled && entry.source !== "builtin";
  const removable = canInstall && entry.install !== undefined && !entry.enabled;
  const pending = pendingIds.has(manifest.id);
  const toggleReason = toggleRefusal(roster, entry, canManage);
  const declaredSeats = workspacePanelSeats(entry);
  const missingSeats = missingWorkspacePanelSeats(entry, layout);
  const missingSeatIds = new Set(missingSeats.map((seat) => seat.panelId));

  return (
    <Stack className="plugin-manager-detail" gap="0.75rem" data-testid="plugin-manager-detail">
      <header className="plugin-manager-sheet-header">
        <button
          className="plugin-manager-sheet-back"
          type="button"
          aria-label="Back to the list"
          onClick={onBack}
        >
          <ControlIcon kind="collapsed" size={13} /> Back
        </button>
        <div className="plugin-manager-sheet-title">
          <h3>{manifest.title}</h3>
          <small>
            {manifest.id} · {manifest.version}
          </small>
        </div>
        <button
          className="plugin-manager-sheet-close"
          type="button"
          aria-label="Close the detail sheet"
          onClick={onBack}
        >
          <ControlIcon kind="close" size={14} />
        </button>
      </header>
      <Cluster className="plugin-manager-sheet-chips" gap="0.3rem">
        {entry.install === undefined ? null : (
          <Chip tone="publisher" title={`Published by ${publisherOf(manifest.id)}`}>
            {publisherOf(manifest.id)}
          </Chip>
        )}
        <Chip tone={status.tone} title={status.why ?? undefined}>
          {status.word}
        </Chip>
        <Chip tone="muted" title={permissionSummary(entry)}>
          {String(permissionCount(entry))} permission{permissionCount(entry) === 1 ? "" : "s"}
        </Chip>
      </Cluster>
      <div className="plugin-manager-sheet-source" data-testid="plugin-manager-detail-source">
        {entry.source === "builtin" ? (
          <span>An engine door</span>
        ) : entry.install === undefined ? (
          <span>Built-in</span>
        ) : (
          <span title={entry.install.source}>
            Installed from <code>{entry.install.source}</code> · sha256{" "}
            <code title={entry.install.sha256}>{entry.install.sha256.slice(0, 12)}</code>{" "}
            <button
              className="plugin-manager-copy"
              type="button"
              aria-label="Copy the full sha256"
              onClick={() => {
                if (entry.install === undefined) return;
                void navigator.clipboard.writeText(entry.install.sha256).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        )}
        {links?.repository === undefined ? null : (
          <span>
            Source{" "}
            <a
              className="plugin-manager-link"
              href={links.repository}
              title={links.repository}
              target="_blank"
              rel="noreferrer"
            >
              {linkHost(links.repository)}
            </a>
          </span>
        )}
        {links?.homepage === undefined ? null : (
          <a
            className="plugin-manager-link"
            href={links.homepage}
            title={links.homepage}
            target="_blank"
            rel="noreferrer"
          >
            Homepage
          </a>
        )}
        {links?.changelog === undefined ? null : (
          <a
            className="plugin-manager-link"
            href={links.changelog}
            title={links.changelog}
            target="_blank"
            rel="noreferrer"
          >
            Changelog
          </a>
        )}
      </div>
      {manifest.description === "" ? null : (
        <p className="plugin-manager-sheet-description">{manifest.description}</p>
      )}

      <SheetCard title="Status" testid="plugin-manager-detail-status">
        <div className="plugin-manager-status-line">
          <Chip tone={status.tone}>{status.word}</Chip>
          {entry.source === "builtin" ? null : (
            <EnableToggle
              entry={entry}
              reason={toggleReason}
              pending={pending}
              onToggle={(enabled) => onToggle(entry, enabled)}
            />
          )}
        </div>
        {status.why === null ? null : <p className="plugin-manager-why">{status.why}</p>}
        {typeof entry.changedBy === "string" ? (
          <p className="plugin-manager-sheet-muted">
            Last changed by {entry.changedBy}
            {typeof entry.changedAt === "number" ? ` · ${WHEN.format(entry.changedAt)}` : ""}
          </p>
        ) : (
          <p className="plugin-manager-sheet-muted">Never toggled</p>
        )}
        {entry.install === undefined ? null : (
          <p className="plugin-manager-sheet-muted">
            Installed by {entry.install.installedBy} · {WHEN.format(entry.install.installedAt)}
          </p>
        )}
      </SheetCard>

      <UpdatesCard
        entry={entry}
        roster={roster}
        canInstall={canInstall}
        busy={
          pendingIds.has(ENGINE_REVIEW_UPDATE_ACTION) || pendingIds.has(ENGINE_APPLY_UPDATE_ACTION)
        }
        pluginTitle={pluginTitle}
        onSelect={onSelect}
        onReviewUpdate={onReviewUpdate}
      />

      {declaredSeats.length === 0 ? null : (
        <SheetCard title="Workspace panels">
          <p className="plugin-manager-sheet-muted">
            {entry.enabled
              ? "Your arrangement stays unchanged until you add a panel."
              : "Switch this plugin on before adding its panels."}
          </p>
          <ul className="plugin-manager-seats" data-testid="plugin-manager-detail-seats">
            {declaredSeats.map((seat) => (
              <li key={seat.panelId}>
                <span>{seat.title}</span>
                {missingSeatIds.has(seat.panelId) ? (
                  <button
                    className="plugin-manager-filter"
                    type="button"
                    disabled={!entry.enabled}
                    onClick={() => onSeatPanels([seat.panelId])}
                  >
                    Add
                  </button>
                ) : (
                  <small>In workspace</small>
                )}
              </li>
            ))}
          </ul>
          {entry.enabled && missingSeats.length > 1 ? (
            <button
              className="plugin-manager-filter"
              type="button"
              data-testid="plugin-manager-add-all-seats"
              onClick={() => onSeatPanels(missingSeats.map((seat) => seat.panelId))}
            >
              Add all {String(missingSeats.length)} panels
            </button>
          ) : null}
        </SheetCard>
      )}

      <MachineRuntime key={manifest.id} host={host} entry={entry} />

      <SheetCard title="Permissions" testid="plugin-manager-detail-permissions">
        {permissions.length === 0 ? (
          <p className="plugin-manager-sheet-muted">Declares no capabilities.</p>
        ) : (
          <>
            {entry.install === undefined ? null : (
              <p className="plugin-manager-sheet-muted">{permissionSummary(entry)}</p>
            )}
            <ul className="plugin-manager-permissions">
              {permissions.map((permission) => (
                <li
                  key={permission.cap}
                  className={`plugin-manager-permission${
                    permission.state === "granted" ? "" : ` is-${permission.state}`
                  }`}
                  title={
                    permission.state === "withheld"
                      ? "Declared, but withheld by the installer"
                      : permission.state === "governed"
                        ? "Governed: no grant ever carries this one. It is discharged per node, bound to an artifact revision, by consent."
                        : undefined
                  }
                >
                  <code>{permission.cap}</code>
                  <span>{permission.meaning}</span>
                  {permission.state === "granted" ? null : <small>{permission.state}</small>}
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetCard>

      <SheetCard title="Doors" testid="plugin-manager-detail-doors">
        {entry.actions.length === 0 ? (
          <p className="plugin-manager-sheet-muted">Publishes no doors of its own.</p>
        ) : (
          <ul className="plugin-manager-doors">
            {entry.actions.map((action: ActionSummary) => (
              <li key={action.name} className="plugin-manager-door" title={action.name}>
                <div className="plugin-manager-door-name">
                  <code>{action.name.slice(manifest.id.length + 1)}</code>
                  <span>{action.title}</span>
                </div>
                <Cluster gap="0.2rem">
                  {action.caps.map((cap) => (
                    <Chip key={cap} tone="muted" title={cap}>
                      {cap}
                    </Chip>
                  ))}
                  <Chip tone="muted" title={`Graded for ${action.scope} authority`}>
                    {action.scope}
                  </Chip>
                  {action.cleanup === true ? (
                    <Chip tone="muted" title="Stays open while the plugin is off">
                      cleanup
                    </Chip>
                  ) : null}
                </Cluster>
              </li>
            ))}
          </ul>
        )}
      </SheetCard>

      {[
        contributes.panels,
        contributes.sections,
        contributes.elements,
        contributes.tools,
        contributes.events,
        contributes.routes ?? [],
        contributes.settings ?? [],
        contributes.disciplines ?? [],
      ].every((kind) => kind.length === 0) ? null : (
        <SheetCard title="Contributes" testid="plugin-manager-detail-contributes">
          <ContributedKind label="Panels" items={contributes.panels} />
          <ContributedKind label="Sections" items={contributes.sections} />
          <ContributedKind
            label="Elements"
            items={contributes.elements.map((element) => ({
              id: element.type,
              title: element.title,
            }))}
          />
          <ContributedKind label="Tools" items={contributes.tools} />
          <ContributedKind label="Events" items={contributes.events} />
          <ContributedKind
            label="Routes"
            items={(contributes.routes ?? []).map((route) => ({
              id: `/${route.segment}/`,
              title: route.title,
            }))}
          />
          <ContributedKind label="Settings" items={contributes.settings ?? []} />
          <ContributedKind label="Disciplines" items={contributes.disciplines ?? []} />
        </SheetCard>
      )}

      {parentId === null && children.length === 0 ? null : (
        <SheetCard title="Family" testid="plugin-manager-detail-family">
          {parentId === null ? (
            <ul className="plugin-manager-family">
              {children.map((child) => {
                const childStatus = pluginStatus(roster, child);
                return (
                  <li key={child.manifest.id} className="plugin-manager-family-child">
                    <PluginLink
                      id={child.manifest.id}
                      pluginTitle={pluginTitle}
                      onSelect={onSelect}
                    />
                    <Chip tone={childStatus.tone} title={childStatus.why ?? undefined}>
                      {childStatus.word}
                    </Chip>
                    <EnableToggle
                      entry={child}
                      reason={toggleRefusal(roster, child, canManage)}
                      pending={pendingIds.has(child.manifest.id)}
                      onToggle={(enabled) => onToggle(child, enabled)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="plugin-manager-relation">
              Part of <PluginLink id={parentId} pluginTitle={pluginTitle} onSelect={onSelect} />
              {" — "}
              its toggle is the family's.
            </p>
          )}
        </SheetCard>
      )}

      {requires.length === 0 &&
      requiredBy.length === 0 &&
      relations.incompatible.length === 0 ? null : (
        <SheetCard title="Relations" testid="plugin-manager-detail-relations">
          {requires.length === 0 ? null : (
            <p className="plugin-manager-relation">
              Requires{" "}
              {requires.map((id, index) => (
                <span key={id}>
                  {index === 0 ? "" : ", "}
                  <PluginLink id={id} pluginTitle={pluginTitle} onSelect={onSelect} />
                </span>
              ))}
            </p>
          )}
          {requiredBy.length === 0 ? null : (
            <p className="plugin-manager-relation">
              Required by{" "}
              {requiredBy.map((id, index) => (
                <span key={id}>
                  {index === 0 ? "" : ", "}
                  <PluginLink id={id} pluginTitle={pluginTitle} onSelect={onSelect} />
                </span>
              ))}
            </p>
          )}
          {relations.incompatible.length === 0 ? null : (
            <p className="plugin-manager-relation">
              Incompatible with{" "}
              {relations.incompatible.map((id, index) => (
                <span key={id}>
                  {index === 0 ? "" : ", "}
                  <PluginLink id={id} pluginTitle={pluginTitle} onSelect={onSelect} />
                </span>
              ))}
            </p>
          )}
        </SheetCard>
      )}

      <SheetCard title="Settings" testid="plugin-manager-detail-settings">
        <SettingsPane
          settings={declared}
          pluginTitle={manifest.title}
          pending={pendingSetting}
          canManage={canManage}
          onSet={onSet}
        />
      </SheetCard>

      {entry.source === "builtin" ? null : (
        <SheetCard title="Danger zone" testid="plugin-manager-detail-danger">
          <p className="plugin-manager-purges">{purgeDeclaration(entry)}.</p>
          <div className="plugin-manager-danger">
            {/*
              A purge is offered on a DISABLED row and nowhere else, because that is the door's
              own rule rather than a second one written here: `engine.plugins.purge` is refused
              while the plugin is enabled (class `still_enabled`), and an affordance that always
              fails is exactly what §5's "never offer a lever the door refuses" forbids. It is
              two-press by construction: the first press says what will happen, the second does
              it, and losing focus or Escape disarms.
             */}
            <button
              className={`plugin-manager-purge${armed ? " is-confirming" : ""}`}
              type="button"
              aria-label={
                armed
                  ? `Confirm purging ${manifest.title} — this cannot be undone`
                  : `Purge ${manifest.title}`
              }
              title={
                purgeable
                  ? `${purgeDeclaration(entry)}. ${armed ? "Press again to destroy it." : "Press to confirm."}`
                  : entry.enabled
                    ? "Switch it off first: purge is refused while a plugin is on"
                    : "Requires plugins:manage"
              }
              data-action={ENGINE_PURGE_ACTION}
              data-testid="plugin-manager-purge"
              data-confirming={armed}
              disabled={!purgeable || pending}
              onBlur={() => onArm(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  onArm(false);
                }
              }}
              onClick={() => {
                if (armed) onPurge();
                else onArm(true);
              }}
            >
              {armed ? "Purge? This cannot be undone" : "Purge data"}
            </button>
            {entry.install === undefined ? null : (
              <button
                className="plugin-manager-purge"
                type="button"
                aria-label={`Uninstall ${manifest.title}`}
                title={
                  removable
                    ? `Uninstall ${manifest.title} — its stored data is kept; purge destroys it`
                    : entry.enabled
                      ? "Switch it off first: uninstall is refused while a plugin is on"
                      : "Uninstalling needs the root capability"
                }
                data-action={ENGINE_UNINSTALL_ACTION}
                data-testid="plugin-manager-uninstall"
                disabled={!removable || pending}
                onClick={onUninstall}
              >
                Uninstall
              </button>
            )}
          </div>
        </SheetCard>
      )}
    </Stack>
  );
}

/**
 * Why a row's toggle is INERT, in words, or null when it may move. The roster's own `refusal`
 * class decides (every class is a refusal the door would produce, so the UI names the obstacle
 * instead of offering a lever that always fails), with one family refinement: a child whose
 * parent is off says so by the parent's name, because "atyrode.code is off" is the sentence a
 * reader acts on, and the door's `dependency_disabled` is the same fact from the engine's side.
 */
function toggleRefusal(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
  canManage: boolean,
): string | null {
  if (entry.held !== undefined) return entry.held.reason;
  if (!canManage) return "Requires plugins:manage";
  const parentId = parentOf(roster, entry);
  if (parentId !== null && !entry.enabled) {
    const parent = roster.find((candidate) => candidate.manifest.id === parentId);
    if (parent !== undefined && !parent.enabled) return `${parentId} is off`;
  }
  const status = pluginStatus(roster, entry);
  switch (entry.refusal) {
    case "essential":
    case "builtin":
    case "dependency_disabled":
    case "missing_dependency":
    case "data_downgrade":
    case "data_migration_missing":
    case "element_type_owned":
    case "unknown_plugin":
    case "developer_mode_off":
    case "stylesheet_unscoped":
      return status.why;
    case "incompatible_dependency":
    case "still_enabled":
    case undefined:
      return null;
    default: {
      const exhaustive: never = entry.refusal;
      return exhaustive;
    }
  }
}

/**
 * ONE ROW of the list: the ledger line a reader acts on. A family's parent carries the
 * chevron and the family summary; a child is the same row, indented. The row itself is
 * focusable and opens the sheet on click or Enter; its controls stop the click so a toggle
 * press never also opens the detail. An installed family's ROOT wears the hub's update
 * observation — the one row a family update is reviewed from — and only a root-capable reader
 * gets it as a button.
 */
function PluginRow({
  entry,
  roster,
  child,
  family,
  expanded,
  selected,
  jump,
  pending,
  canManage,
  canInstall,
  updateBusy,
  onReviewUpdate,
  onExpand,
  onSelect,
  onToggle,
}: {
  readonly entry: PluginRosterEntry;
  readonly roster: readonly PluginRosterEntry[];
  readonly child: boolean;
  readonly family: readonly PluginRosterEntry[];
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly jump: boolean;
  readonly pending: boolean;
  readonly canManage: boolean;
  readonly canInstall: boolean;
  readonly updateBusy: boolean;
  readonly onReviewUpdate: (rootId: string) => void;
  readonly onExpand: () => void;
  readonly onSelect: () => void;
  readonly onToggle: (enabled: boolean) => void;
}): ReactElement {
  const { manifest } = entry;
  const status = pluginStatus(roster, entry);
  const permissions = permissionCount(entry);
  const ownership = updateOwnership(roster, entry);
  const update =
    ownership.kind === "feed" && ownership.root.manifest.id === manifest.id
      ? entry.install?.update
      : undefined;
  const links = manifest.links;
  const classes = [
    "plugin-manager-row",
    entry.enabled ? "" : "is-disabled",
    child ? "is-child" : "",
    selected ? "is-selected" : "",
    jump ? "is-jump-target" : "",
    family.length > 0 ? "is-family" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
  const open = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (
      target instanceof Element &&
      target !== event.currentTarget &&
      target.closest("button, a, input") !== null
    ) {
      return;
    }
    onSelect();
  };
  return (
    <div
      className={classes}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-plugin={manifest.id}
      data-source={entry.source}
      data-status={status.tone}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) open(event);
      }}
    >
      {family.length === 0 ? (
        <span className="plugin-manager-row-expand" aria-hidden="true" />
      ) : (
        <button
          className="plugin-manager-row-expand"
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} the parts of ${manifest.title}`}
          data-testid="plugin-manager-family-expand"
          onClick={(event) => {
            event.stopPropagation();
            onExpand();
          }}
        >
          <ControlIcon kind={expanded ? "disclosed" : "collapsed"} size={13} />
        </button>
      )}
      <span className="plugin-manager-label">
        <strong title={manifest.description}>{manifest.title}</strong>
        <small>
          {manifest.id} · {manifest.version}
          {family.length === 0 ? null : (
            <span
              className="plugin-manager-family-summary"
              data-testid="plugin-manager-family-summary"
            >
              {" · "}
              {familySummary(family)}
            </span>
          )}
        </small>
        {status.tone === "attention" && status.why !== null ? (
          <small className="plugin-manager-why" role="status">
            {status.why}
          </small>
        ) : null}
      </span>
      <span className="plugin-manager-chips">
        {entry.install === undefined ? null : (
          <Chip
            tone="muted"
            title={
              entry.install.hardened === true
                ? "Runs in a separate process and browser Worker"
                : "Runs with React and the full engine API"
            }
          >
            {entry.install.hardened === true ? "Hardened" : "In-realm"}
          </Chip>
        )}
        {entry.install?.mode !== "unpacked" ? null : (
          <Chip
            tone="muted"
            title="Built by this hub from its directory under <data>/authored/ on every save; admitted only while developer mode is on"
          >
            Unpacked
          </Chip>
        )}
        {entry.install === undefined ? null : links?.repository === undefined ? (
          <Chip tone="publisher" title={`Published by ${publisherOf(manifest.id)}`}>
            {publisherOf(manifest.id)}
          </Chip>
        ) : (
          <a
            className="plugin-manager-chip"
            data-tone="publisher"
            href={links.repository}
            title={links.repository}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {publisherOf(manifest.id)}
          </a>
        )}
        {update?.state !== "available" ? null : canInstall ? (
          <button
            className="plugin-manager-chip"
            data-tone="update"
            type="button"
            data-action={ENGINE_REVIEW_UPDATE_ACTION}
            title={`${updateStatusWords(update)} Press to review exactly what it changes.`}
            aria-label={`Review the ${update.version} update of ${manifest.title}`}
            disabled={updateBusy}
            onClick={(event) => {
              event.stopPropagation();
              onReviewUpdate(manifest.id);
            }}
          >
            {update.version} available
          </button>
        ) : (
          <Chip
            tone="update"
            title={`${updateStatusWords(update)} Reviewing and applying it needs the root capability.`}
          >
            {update.version} available
          </Chip>
        )}
        {update?.state !== "failed" ? null : (
          <Chip tone="muted" title={updateStatusWords(update)}>
            Update check failed
          </Chip>
        )}
        <Chip tone={status.tone} title={status.why ?? status.word} testid="plugin-manager-status">
          {status.word}
        </Chip>
        <Chip tone="muted" title={permissionSummary(entry)} testid="plugin-manager-permissions">
          {String(permissions)} permission{permissions === 1 ? "" : "s"}
        </Chip>
      </span>
      {entry.source === "builtin" ? (
        <span className="plugin-manager-toggle-slot" aria-hidden="true" />
      ) : (
        <EnableToggle
          entry={entry}
          reason={toggleRefusal(roster, entry, canManage)}
          pending={pending}
          onToggle={onToggle}
        />
      )}
      <button
        className="plugin-manager-row-open"
        type="button"
        aria-label={`Show details of ${manifest.title}`}
        data-testid="plugin-manager-row-open"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <ControlIcon kind="collapsed" size={13} />
      </button>
    </div>
  );
}

export function PluginManagerSection({ host }: SectionProps): ReactElement {
  const assembly = host.assembly;
  const roster = assembly.roster();
  /** The one switch for unpacked rows (ADR 0025 §4), read beside the roster it rides with. */
  const developerMode = assembly.developerMode();
  /*
    THE COMPOSED SETTINGS TABLE, read exactly as the roster is: the engine's own join of every
    manifest's declarations with this principal's stored values. The sheet's settings card is a
    view of it and nothing more — this section holds no settings state of its own.
  */
  const settings = assembly.settings;
  const caps = host.client.selfCaps();
  const canManage = caps.includes("*") || caps.includes("plugins:manage");
  /** Installing admits a stranger's code: root only, the door's own rule (`caps: ["*"]`). */
  const canInstall = caps.includes("*");
  const subscribeAuthority = useCallback(
    (notify: () => void) => host.client.onAuthorityChange(notify),
    [host.client],
  );
  const readWorkspaceCaps = useCallback(() => host.client.workspaceCaps(), [host.client]);
  const workspaceCaps = useSyncExternalStore(
    subscribeAuthority,
    readWorkspaceCaps,
    readWorkspaceCaps,
  );
  const { sidebarOpen, layout, seatPanels } = useWorkspaceShell();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PluginSort>("name");
  const [filters, setFilters] = useState<ReadonlySet<PluginFilter>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<PluginCategoryKind>>(initialCollapsed);
  /** Which families are OPEN, by parent id. Session-local: a chevron, not a preference. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** The row the sheet shows. One slot: a sheet is a place a reader is looking, and two is not one. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  /** Every id a dispatch is in flight for — a family toggle holds the whole family. */
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  /** The last install or uninstall's own record, in words: the row it describes may be gone. */
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  /** The last install attempt's refusal, in words, shown under the form it came from. */
  const [installFailure, setInstallFailure] = useState<string | null>(null);
  /**
   * Whether the sheet's purge is ARMED. A purge is destructive and workspace-global, so it is
   * a two-press act by construction; one flag, because it belongs to the one selected row.
   */
  const [armed, setArmed] = useState(false);
  /**
   * The last purge's own record, kept at SECTION level on purpose: the row it describes is
   * gone from the roster by the time it renders, and a destructive verb that leaves nothing
   * behind to read cannot be audited.
   */
  const [removed, setRemoved] = useState<PluginPurgeResult | null>(null);
  /** The setting ref a write is in flight for, so exactly that switch goes inert. */
  const [pendingSetting, setPendingSetting] = useState<string | null>(null);
  /**
   * The row a relation link is jumping to. Set together with clearing the search and filters
   * (either may be hiding the target) and opening its family; the effect scrolls once the
   * unfiltered list has painted, and the highlight retires itself.
   */
  const [jumpId, setJumpId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [seatSuggestionState, setSeatSuggestionState] = useState(() =>
    initialSeatSuggestions(roster),
  );
  const reconciledSeatSuggestions = reconcileSeatSuggestions(seatSuggestionState, roster, layout);
  if (reconciledSeatSuggestions !== seatSuggestionState) {
    setSeatSuggestionState(reconciledSeatSuggestions);
  }
  const suggestedSeats = suggestedWorkspacePanelSeats(reconciledSeatSuggestions, roster, layout);

  useEffect(() => {
    if (jumpId === null) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          `[data-testid="plugin-manager"] [data-plugin="${CSS.escape(jumpId)}"]`,
        )
        ?.scrollIntoView({ block: "center" });
    });
    const timer = window.setTimeout(() => setJumpId(null), 1400);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [jumpId]);

  /**
   * SHOW THIS PLUGIN: select it for the sheet, and make its row visible — clear whatever
   * search or filter may be hiding it, unfold its section, open its family. One answer for a
   * relation link, a family link and a deep link, so the three cannot drift.
   */
  const show = useCallback(
    (id: string): void => {
      const entry = roster.find((candidate) => candidate.manifest.id === id);
      setQuery("");
      setFilters(new Set());
      setSelectedId(id);
      setArmed(false);
      if (entry !== undefined) {
        const kind = pluginCategoryKind(entry);
        setCollapsed((current) => {
          if (!current.has(kind)) return current;
          const next = new Set(current);
          next.delete(kind);
          rememberCollapsed(next);
          return next;
        });
        const parentId = parentOf(roster, entry);
        if (parentId !== null) {
          setExpanded((current) =>
            current.has(parentId) ? current : new Set(current).add(parentId),
          );
        }
      }
      setJumpId(id);
    },
    [roster],
  );

  /**
   * THE DEEP-LINK ANSWER (#133). `manifold://plugin/<id>` is an address like any other, and
   * this is the surface that shows a plugin — so when the shell publishes such a request
   * (`host.requestedRef`), the manager opens on that row with its sheet out. A ROUTE ANSWER,
   * not a modal bus: the shell puts an address on the route, this reads it, and a build where
   * `core.plugins` is disabled simply leaves the address unanswered. Answered DURING RENDER
   * rather than in an effect, so a cold load onto a link never paints the manager shut first;
   * the guard is the last answered address, so a second link is answered while any other
   * re-render is not.
   */
  const requested = host.requestedRef;
  const [answered, setAnswered] = useState<ManifoldRef | null>(null);
  if (requested !== answered) {
    setAnswered(requested);
    if (requested !== null && requested.kind === "plugin") {
      setOpen(true);
      show(requested.pluginId);
    }
  }

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [open]);

  const holdPending = (ids: readonly string[], held: boolean): void => {
    setPendingIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (held) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  /**
   * Where focus returns when an update review closes: the control that opened it, or — when
   * that control is gone, as an "available" chip is once its update lands — the family root's
   * own row, which stays in the list.
   */
  const updateOpener = useRef<HTMLElement | null>(null);
  const refocusUpdate = (rootId: string): void => {
    const opener = updateOpener.current;
    updateOpener.current = null;
    window.requestAnimationFrame(() => {
      if (opener?.isConnected === true) opener.focus();
      if (opener !== null && document.activeElement === opener) return;
      dialogRef.current
        ?.querySelector<HTMLElement>(
          `[data-testid="plugin-manager"] [data-plugin="${CSS.escape(rootId)}"]`,
        )
        ?.focus();
    });
  };
  const updates = useUpdateReview({
    host,
    roster,
    canInstall,
    holdPending,
    onApplied: (rootId, notice) => {
      setInstallNotice(notice);
      refocusUpdate(rootId);
    },
  });
  const reviewUpdate = (rootId: string): void => {
    updateOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void updates.review(rootId);
  };
  const closeUpdate = (): void => {
    const rootId = updates.session?.rootId;
    if (updates.close() && rootId !== undefined) refocusUpdate(rootId);
  };
  const updateBusy =
    pendingIds.has(ENGINE_REVIEW_UPDATE_ACTION) || pendingIds.has(ENGINE_APPLY_UPDATE_ACTION);

  /** Closing DISARMS and forgets the sheet: nothing destructive waits behind a closed door. */
  const close = (): void => {
    setOpen(false);
    setArmed(false);
    setSelectedId(null);
    setInstallOpen(false);
    updates.close();
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  /** One press on the enablement door; answers whether the workspace agreed. */
  const dispatchEnabled = async (id: string, enabled: boolean): Promise<boolean> => {
    try {
      const outcome = await host.client.action(ENGINE_SET_ENABLED_ACTION, { id, enabled });
      // No local flip: the roster is server-owned and arrives on the connection frame, so
      // the list changes when the WORKSPACE changes, never because this tab clicked.
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return false;
      }
      return true;
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not change the plugin");
      return false;
    }
  };

  /**
   * THE TOGGLE, and the family toggle it becomes on a parent (ADR 0023 §9). There is no
   * cascade at the door — disabling a parent whose parts are on meets `missing_dependency`,
   * and a cascade would be other principals' plugins vanishing without consent — so the
   * manager turns a family off by pressing the parts' toggles and then the parent's, and on
   * in the reverse order: N+1 traced dispatches through the one enablement door, no new door
   * (docs/CONTRACTS.md §One authoritative implementation). A part that already reads the asked state is skipped, and the first
   * refusal stops the sequence with its message shown, so a half-turned family is never
   * silent.
   */
  const toggle = async (entry: PluginRosterEntry, enabled: boolean): Promise<void> => {
    const parts = childrenOf(roster, entry.manifest.id);
    const order = enabled ? [entry, ...parts] : [...parts, entry];
    const ids = order.map((row) => row.manifest.id);
    holdPending(ids, true);
    setFailure(null);
    setArmed(false);
    setRemoved(null);
    try {
      for (const row of order) {
        if (row.enabled === enabled) continue;
        if (!(await dispatchEnabled(row.manifest.id, enabled))) return;
      }
    } finally {
      holdPending(ids, false);
    }
  };

  /** The developer-mode switch: root only, the door's own rule; the roster frame answers. */
  const setDeveloperMode = async (on: boolean): Promise<void> => {
    holdPending([ENGINE_SET_DEVELOPER_MODE_ACTION], true);
    setFailure(null);
    try {
      const outcome = await host.client.action(ENGINE_SET_DEVELOPER_MODE_ACTION, { on });
      if (!outcome.ok) setFailure(outcome.denial.message);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not change developer mode");
    } finally {
      holdPending([ENGINE_SET_DEVELOPER_MODE_ACTION], false);
    }
  };

  /**
   * The destructive door, and the only caller of it in the UI. It answers an EXHAUSTIVE
   * record — every target, zeros included — so the outcome is parsed rather than trusted:
   * "nothing was removed" and "that target was not considered" must not read alike.
   */
  const purge = async (id: string): Promise<void> => {
    holdPending([id], true);
    setFailure(null);
    setRemoved(null);
    try {
      const outcome = await host.client.action(ENGINE_PURGE_ACTION, { id });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const record = PluginPurgeResultSchema.safeParse(outcome.result);
      if (record.success) setRemoved(record.data);
      else setFailure(`${id} was purged, but its removal record could not be read`);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not purge the plugin");
    } finally {
      holdPending([id], false);
      setArmed(false);
    }
  };

  /** Re-read the authoritative map after the single settings door commits. */
  const setSetting = async (setting: ComposedSetting, value: boolean | string): Promise<void> => {
    setPendingSetting(setting.ref);
    setFailure(null);
    try {
      const outcome = await host.client.action(ENGINE_SET_SETTING_ACTION, {
        plugin: setting.plugin,
        setting: setting.id,
        value,
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      assembly.refreshSettings();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not change the setting");
    } finally {
      setPendingSetting(null);
    }
  };

  /**
   * THE INSTALL DOOR, and its inverse. Both are the engine's, both refuse by a named class
   * the message carries first, and neither is followed by a local flip: an installed row
   * arrives on the next `plugins` frame exactly as a toggled one does. The result is parsed
   * rather than trusted — a row that says "installed" but whose grant this section could not
   * read would be a consent nobody can audit.
   */
  const install = async (draft: InstallDraft): Promise<void> => {
    holdPending([ENGINE_INSTALL_ACTION], true);
    setInstallFailure(null);
    setInstallNotice(null);
    try {
      const outcome = await host.client.action(ENGINE_INSTALL_ACTION, {
        source: draft.source,
        sha256: draft.sha256,
        hardened: draft.hardened,
        ...(draft.grant.length === 0 ? {} : { grant: [...draft.grant] }),
      });
      if (!outcome.ok) {
        setInstallFailure(installRefusalWords(outcome.denial.message));
        return;
      }
      const record = PluginInstallResultSchema.safeParse(outcome.result);
      if (record.success) {
        const granted =
          record.data.grantedCaps.length === 0 ? "nothing" : record.data.grantedCaps.join(", ");
        // A grant never carries a governed capability — `grantFor` filters them out of an
        // explicit installer grant as well as the default one — so an installer who named one
        // is told, rather than left to compare this notice against the manifest and conclude
        // the install dropped it (#733).
        const ignored = draft.grant.filter((cap) => GOVERNED_CAPS.includes(cap));
        setInstallNotice(
          `Installed ${record.data.id} ${record.data.version} — granted ${granted}${
            ignored.length === 0
              ? ""
              : `. No grant carries ${ignored.join(", ")}: governed authority is consented per node, at an artifact revision, not granted at install`
          }`,
        );
        setInstallOpen(false);
      } else {
        setInstallFailure("The bundle was installed, but its install record could not be read");
      }
    } catch (reason: unknown) {
      setInstallFailure(reason instanceof Error ? reason.message : "Could not install the plugin");
    } finally {
      holdPending([ENGINE_INSTALL_ACTION], false);
    }
  };

  const uninstall = async (id: string): Promise<void> => {
    holdPending([id], true);
    setFailure(null);
    setInstallNotice(null);
    try {
      const outcome = await host.client.action(ENGINE_UNINSTALL_ACTION, { id });
      if (!outcome.ok) setFailure(outcome.denial.message);
      else {
        setInstallNotice(`Uninstalled ${id} — its stored data is kept; purge destroys it`);
        setSelectedId(null);
      }
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not uninstall the plugin");
    } finally {
      holdPending([id], false);
    }
  };

  const foldSection = (kind: PluginCategoryKind): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      rememberCollapsed(next);
      return next;
    });
  };

  const sections = pluginCatalog(roster, { query, sort, filters });
  const plugins = roster.filter((entry) => entry.source !== "builtin");
  const on = plugins.filter((entry) => entry.enabled).length;
  const selected =
    selectedId === null ? null : (roster.find((entry) => entry.manifest.id === selectedId) ?? null);
  const pluginTitle = (id: string): string => assembly.pluginTitle(id) ?? id;
  const narrowed = query.trim() !== "" || filters.size > 0;

  /** How many distinct publishers a section's rows come from: the divider is drawn past one. */
  const publishers = (rows: readonly PluginFamilyRow[]): number =>
    new Set(rows.map((row) => publisherOf(row.entry.manifest.id))).size;

  const renderRow = (
    entry: PluginRosterEntry,
    child: boolean,
    family: readonly PluginRosterEntry[],
    expandedRow: boolean,
  ): ReactElement => (
    <PluginRow
      key={entry.manifest.id}
      entry={entry}
      roster={roster}
      child={child}
      family={family}
      expanded={expandedRow}
      selected={selectedId === entry.manifest.id}
      jump={jumpId === entry.manifest.id}
      pending={pendingIds.has(entry.manifest.id)}
      canManage={canManage}
      canInstall={canInstall}
      updateBusy={updateBusy}
      onReviewUpdate={reviewUpdate}
      onExpand={() =>
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(entry.manifest.id)) next.delete(entry.manifest.id);
          else next.add(entry.manifest.id);
          return next;
        })
      }
      onSelect={() => {
        setArmed(false);
        setSelectedId((current) => (current === entry.manifest.id ? null : entry.manifest.id));
      }}
      onToggle={(enabled) => void toggle(entry, enabled)}
    />
  );

  const list = (
    <Stack className="plugin-manager" gap="0.35rem" data-testid="plugin-manager">
      {workspaceCaps.includes("*") ? <CredentialReferences host={host} /> : null}
      <Cluster className="plugin-manager-controls" gap="0.4rem">
        <input
          className="plugin-manager-search"
          type="search"
          value={query}
          placeholder="Search plugins"
          aria-label="Search plugins by name, id, description or door"
          data-testid="plugin-manager-search"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="plugin-manager-sort">
          <span>Sort</span>
          <select
            value={sort}
            aria-label="Sort plugins"
            data-testid="plugin-manager-sort"
            onChange={(event) => {
              const next = PLUGIN_SORTS.find((candidate) => candidate === event.target.value);
              if (next !== undefined) setSort(next);
            }}
          >
            {PLUGIN_SORTS.map((value) => (
              <option key={value} value={value}>
                {PLUGIN_SORT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </Cluster>
      <div className="plugin-manager-filters" role="group" aria-label="Show only">
        {PLUGIN_FILTERS.map((value) => (
          <button
            key={value}
            className="plugin-manager-filter"
            type="button"
            aria-pressed={filters.has(value)}
            data-testid={`plugin-manager-filter-${value}`}
            onClick={() =>
              setFilters((current) => {
                const next = new Set(current);
                if (next.has(value)) next.delete(value);
                else next.add(value);
                return next;
              })
            }
          >
            {PLUGIN_FILTER_LABELS[value]}
          </button>
        ))}
      </div>
      {!canManage ? (
        <p className="sidebar-muted">
          Read-only: turning plugins on and off needs the <code>plugins:manage</code> capability.
        </p>
      ) : null}
      {failure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      )}
      {removed === null ? null : (
        <p className="plugin-manager-removed" data-testid="plugin-manager-removed" role="status">
          Purged {removed.id} —{" "}
          {PLUGIN_PURGE_TARGETS.map(
            (target) => `${PURGE_TARGET_LABELS[target]} ${String(removed.removed[target] ?? 0)}`,
          ).join(", ")}
        </p>
      )}
      {sections.map((section) => {
        const { def } = section;
        const folded = collapsed.has(def.kind);
        const showInstall = def.installs && canInstall;
        return (
          <section
            className="plugin-manager-category"
            key={def.kind}
            data-kind={def.kind}
            data-collapsed={folded}
            data-testid={`plugin-manager-section-${def.kind}`}
          >
            <h3 className="plugin-manager-category-title">
              <button
                className="plugin-manager-category-open"
                type="button"
                aria-expanded={!folded}
                title={def.note}
                data-testid={`plugin-manager-section-open-${def.kind}`}
                onClick={() => foldSection(def.kind)}
              >
                <ControlIcon kind={folded ? "collapsed" : "disclosed"} size={13} />
                <span>{def.title}</span>
                <span className="plugin-manager-category-count">
                  {def.toggleable
                    ? `${String(section.on)} of ${String(section.size)} on`
                    : String(section.size)}
                </span>
              </button>
              {!showInstall ? null : (
                <button
                  className="plugin-manager-category-action"
                  type="button"
                  aria-expanded={installOpen}
                  data-testid="plugin-manager-install-open"
                  onClick={() => {
                    setInstallOpen((current) => !current);
                    if (folded) foldSection(def.kind);
                  }}
                >
                  <ControlIcon kind="add" size={12} /> Install from bundle
                </button>
              )}
              {!def.develops || !canInstall ? null : (
                <label className="plugin-manager-category-action">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={developerMode}
                    aria-checked={developerMode}
                    data-action={ENGINE_SET_DEVELOPER_MODE_ACTION}
                    data-testid="plugin-manager-developer-mode"
                    title="Admit plugins authored on this instance; off locks every unpacked row"
                    disabled={pendingIds.has(ENGINE_SET_DEVELOPER_MODE_ACTION)}
                    onChange={(event) => void setDeveloperMode(event.target.checked)}
                  />{" "}
                  Developer mode
                </label>
              )}
            </h3>
            {folded ? null : (
              <>
                {def.toggleable ? null : <p className="plugin-manager-category-note">{def.note}</p>}
                {def.installs && installOpen && canInstall ? (
                  <InstallForm
                    busy={pendingIds.has(ENGINE_INSTALL_ACTION)}
                    failure={installFailure}
                    onInstall={(draft) => void install(draft)}
                    onDismiss={() => {
                      setInstallOpen(false);
                      setInstallFailure(null);
                    }}
                  />
                ) : null}
                {!def.installs || installNotice === null ? null : (
                  <p
                    className="plugin-manager-notice"
                    data-testid="plugin-manager-install-notice"
                    role="status"
                  >
                    {installNotice}
                  </p>
                )}
                {section.rows.length === 0 ? (
                  <p className="plugin-manager-category-empty">
                    {section.size === 0 || !narrowed ? def.empty : "Nothing here matches."}
                  </p>
                ) : (
                  section.rows.map((row, index) => {
                    const publisher = publisherOf(row.entry.manifest.id);
                    const previous = section.rows[index - 1];
                    const divider =
                      def.byPublisher &&
                      publishers(section.rows) > 1 &&
                      (previous === undefined ||
                        publisherOf(previous.entry.manifest.id) !== publisher);
                    const isOpen = row.viaChild || expanded.has(row.entry.manifest.id);
                    return (
                      <div className="plugin-manager-family-group" key={row.entry.manifest.id}>
                        {!divider ? null : (
                          <p
                            className="plugin-manager-publisher"
                            title={`Published by ${publisher}`}
                          >
                            {publisher}
                          </p>
                        )}
                        {renderRow(row.entry, false, row.family, isOpen)}
                        {!isOpen
                          ? null
                          : row.children.map((childEntry) =>
                              renderRow(childEntry, true, [], false),
                            )}
                      </div>
                    );
                  })
                )}
              </>
            )}
          </section>
        );
      })}
    </Stack>
  );

  return (
    <>
      <button
        ref={buttonRef}
        className="sidebar-opener"
        type="button"
        title={
          suggestedSeats.length === 0
            ? "Plugins: what this workspace composed, and what is on"
            : `Plugins: ${String(suggestedSeats.length)} workspace ${suggestedSeats.length === 1 ? "panel is" : "panels are"} available`
        }
        aria-label={
          suggestedSeats.length === 0
            ? "Show the plugin manager"
            : `Show the plugin manager; ${String(suggestedSeats.length)} workspace ${suggestedSeats.length === 1 ? "panel is" : "panels are"} available`
        }
        data-testid="plugin-manager-open"
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="assembly" />
        {sidebarOpen ? <span>Plugins</span> : null}
        {suggestedSeats.length === 0 ? null : (
          <span
            className="plugin-manager-seat-badge"
            aria-label={`${String(suggestedSeats.length)} workspace panels available`}
          >
            {String(suggestedSeats.length)}
          </span>
        )}
      </button>
      {sidebarOpen && suggestedSeats.length > 0 ? (
        <div
          className="plugin-manager-seat-suggestion"
          role="status"
          data-testid="plugin-manager-seat-suggestion"
        >
          <p>
            <strong>
              {String(suggestedSeats.length)} new {suggestedSeats.length === 1 ? "panel" : "panels"}
            </strong>
            <span>Layout unchanged.</span>
          </p>
          <div>
            <button
              type="button"
              data-testid="plugin-manager-seat-suggestion-add"
              onClick={() => seatPanels(suggestedSeats.map((seat) => seat.panelId))}
            >
              {suggestedSeats.length === 1 ? "Add" : "Add all"}
            </button>
            <button
              type="button"
              onClick={() => setSeatSuggestionState((current) => dismissSeatSuggestions(current))}
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {typeof document !== "undefined" && open
        ? createPortal(
            <dialog
              ref={dialogRef}
              className="plugin-manager-dialog"
              aria-labelledby="plugin-manager-title"
              onCancel={(event) => {
                // Escape retreats one level: the sheet first, then the modal.
                event.preventDefault();
                if (selected !== null) {
                  setSelectedId(null);
                  setArmed(false);
                } else close();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                close();
              }}
            >
              <section
                className={`plugin-manager-card${selected === null ? "" : " has-sheet"}`}
                data-testid="plugin-manager-modal"
              >
                <header>
                  <div>
                    <span>Workspace</span>
                    <h2 id="plugin-manager-title">Plugins</h2>
                  </div>
                  <p className="plugin-manager-summary" data-testid="plugin-manager-summary">
                    {String(on)} of {String(plugins.length)} on
                  </p>
                  <button type="button" aria-label="Close the plugin manager" onClick={close}>
                    <ControlIcon kind="close" />
                  </button>
                </header>
                <div className="plugin-manager-panes">
                  <ScrollRegion className="plugin-manager-body">{list}</ScrollRegion>
                  {selected === null ? null : (
                    <ScrollRegion
                      className="plugin-manager-sheet"
                      data-testid="plugin-manager-sheet"
                    >
                      <PluginDetail
                        host={host}
                        entry={selected}
                        roster={roster}
                        settings={settings}
                        canManage={canManage}
                        canInstall={canInstall}
                        layout={layout}
                        pendingIds={pendingIds}
                        pendingSetting={pendingSetting}
                        armed={armed}
                        pluginTitle={pluginTitle}
                        onSelect={show}
                        onBack={() => {
                          setSelectedId(null);
                          setArmed(false);
                        }}
                        onSeatPanels={seatPanels}
                        onToggle={(target, enabled) => void toggle(target, enabled)}
                        onArm={(next) => {
                          setArmed(next);
                          if (next) {
                            setFailure(null);
                            setRemoved(null);
                          }
                        }}
                        onPurge={() => void purge(selected.manifest.id)}
                        onUninstall={() => void uninstall(selected.manifest.id)}
                        onSet={(setting, value) => void setSetting(setting, value)}
                        onReviewUpdate={reviewUpdate}
                      />
                    </ScrollRegion>
                  )}
                </div>
              </section>
              {updates.session === null ? null : (
                <UpdateReviewDialog
                  session={updates.session}
                  canInstall={canInstall}
                  pluginTitle={pluginTitle}
                  onReview={() => {
                    if (updates.session !== null) void updates.review(updates.session.rootId);
                  }}
                  onApply={() => void updates.apply()}
                  onAcknowledge={updates.acknowledge}
                  onClose={closeUpdate}
                />
              )}
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
