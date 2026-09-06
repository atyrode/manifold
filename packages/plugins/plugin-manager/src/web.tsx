import "./styles.css";
import {
  ENGINE_INSTALL_ACTION,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  ENGINE_SET_SETTING_ACTION,
  ENGINE_UNINSTALL_ACTION,
  PluginInstallResultSchema,
  type ComposedSetting,
  type SectionProps,
} from "@manifold/plugin";
import {
  PLUGIN_PURGE_TARGETS,
  PluginPurgeResultSchema,
  type ActionSummary,
  type Cap,
  type ManifoldRef,
  type PluginPurgeResult,
  type PluginPurgeTarget,
  type PluginRosterEntry,
} from "@manifold/protocol";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { Cluster, ControlIcon, ScrollRegion, Stack } from "@manifold/plugin/ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
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
  installRefusalWords,
  latestVersion,
  linkHost,
  permissionCount,
  permissionSummary,
  pluginPermissions,
  pluginStatus,
  type PluginStatus,
} from "./status.ts";

/**
 * Composition administration, rendered by the composition it administers (issue #239). The
 * list is the server's roster verbatim (`host.assembly.roster()`), so this section can never
 * disagree with what the workspace actually composed, and every lever is one of the ENGINE's
 * doors — `engine.plugins.setEnabled`, `purge`, `install`, `uninstall`, `setSetting` — so
 * this plugin owns the UI and only the UI. Enablement is workspace-GLOBAL and hot: flipping a
 * toggle here changes what every principal's client composes, and the new roster is pushed
 * rather than polled (D4).
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
}

/** One chip: a word with a tone, and the sentence behind it on hover. */
function Chip({
  tone,
  title,
  testid,
  children,
}: {
  readonly tone?: PluginStatus["tone"] | "muted" | "publisher";
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

/**
 * THE DETAIL SHEET: everything the roster says about one row, as cards. Nothing here is a
 * second read — every card is a projection of the same `PluginRosterEntry` the list renders,
 * plus the composed settings table for the settings card — so the sheet and the row can never
 * disagree about a plugin.
 */
function PluginDetail({
  entry,
  roster,
  settings,
  canManage,
  canInstall,
  pendingIds,
  pendingSetting,
  armed,
  pluginTitle,
  onSelect,
  onBack,
  onToggle,
  onArm,
  onPurge,
  onUninstall,
  onSet,
}: {
  readonly entry: PluginRosterEntry;
  readonly roster: readonly PluginRosterEntry[];
  readonly settings: readonly ComposedSetting[];
  readonly canManage: boolean;
  readonly canInstall: boolean;
  readonly pendingIds: ReadonlySet<string>;
  readonly pendingSetting: string | null;
  readonly armed: boolean;
  readonly pluginTitle: (id: string) => string;
  readonly onSelect: (id: string) => void;
  readonly onBack: () => void;
  readonly onToggle: (target: PluginRosterEntry, enabled: boolean) => void;
  readonly onArm: (armed: boolean) => void;
  readonly onPurge: () => void;
  readonly onUninstall: () => void;
  readonly onSet: (setting: ComposedSetting, value: boolean | string) => void;
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

      <SheetCard title="Permissions" testid="plugin-manager-detail-permissions">
        {permissions.length === 0 ? (
          <p className="plugin-manager-sheet-muted">Declares no capabilities: it can only read.</p>
        ) : (
          <>
            {entry.install === undefined ? null : (
              <p className="plugin-manager-sheet-muted">{permissionSummary(entry)}</p>
            )}
            <ul className="plugin-manager-permissions">
              {permissions.map((permission) => (
                <li
                  key={permission.cap}
                  className={`plugin-manager-permission${permission.granted ? "" : " is-withheld"}`}
                  title={permission.granted ? undefined : "Declared, but withheld by the installer"}
                >
                  <code>{permission.cap}</code>
                  <span>{permission.meaning}</span>
                  {permission.granted ? null : <small>withheld</small>}
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
 * press never also opens the detail.
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
  readonly onExpand: () => void;
  readonly onSelect: () => void;
  readonly onToggle: (enabled: boolean) => void;
}): ReactElement {
  const { manifest } = entry;
  const status = pluginStatus(roster, entry);
  const permissions = permissionCount(entry);
  const latest = latestVersion(entry);
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
        {latest === null ? null : (
          <Chip tone="muted" title={`${latest} is available; ${manifest.version} is installed`}>
            {latest} available
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
  const { sidebarOpen } = useWorkspaceShell();
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

  /** Closing DISARMS and forgets the sheet: nothing destructive waits behind a closed door. */
  const close = (): void => {
    setOpen(false);
    setArmed(false);
    setSelectedId(null);
    setInstallOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

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
   * (invariant 14). A part that already reads the asked state is skipped, and the first
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
        setInstallNotice(`Installed ${record.data.id} ${record.data.version} — granted ${granted}`);
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
        title="Plugins: what this workspace composed, and what is on"
        aria-label="Show the plugin manager"
        data-testid="plugin-manager-open"
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="assembly" />
        {sidebarOpen ? <span>Plugins</span> : null}
      </button>
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
                        entry={selected}
                        roster={roster}
                        settings={settings}
                        canManage={canManage}
                        canInstall={canInstall}
                        pendingIds={pendingIds}
                        pendingSetting={pendingSetting}
                        armed={armed}
                        pluginTitle={pluginTitle}
                        onSelect={show}
                        onBack={() => {
                          setSelectedId(null);
                          setArmed(false);
                        }}
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
                      />
                    </ScrollRegion>
                  )}
                </div>
              </section>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
