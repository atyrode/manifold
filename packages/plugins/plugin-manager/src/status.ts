import {
  CAPS,
  CORE_NAMESPACE_PREFIX,
  GOVERNED_CAPS,
  PLUGIN_INSTALL_REFUSALS,
  formatManifoldUri,
  hasCap,
  isEngineCap,
  type AuthoredCap,
  type Cap,
  type MachineHalf,
  type PluginDependency,
  type PluginDependencyMap,
  type PluginInstallRefusal,
  type PluginLifecycleState,
  type PluginRefusalReason,
  type PluginRosterEntry,
  type PluginUpdateApplyRequest,
  type PluginUpdateApplyResult,
  type PluginUpdateMember,
  type PluginUpdateRefusal,
  type PluginUpdateReview,
} from "@manifold/protocol";

/**
 * WHAT A ROW SAYS ABOUT ITSELF, in a human's words (issue #239).
 *
 * The roster carries the plugin's enabled state, lifecycle and named refusals, plus the
 * server's assembly hold verdict. This module turns those facts into ONE status — a word
 * for the chip, a tone for its colour, and a sentence saying why — so the list, the detail
 * sheet and the attention filter all read the same answer. Assembly holds keep the server's
 * reason intact: the browser must not diagnose the conflict again.
 *
 * Every table below is keyed by the protocol's closed set, so a fifth lifecycle state or an
 * eleventh refusal class cannot be added without this file refusing to compile. A chip that
 * silently printed the enum for a class nobody taught it a sentence for is exactly the
 * failure that shape makes impossible.
 *
 * Pure and total, like `catalog.ts`: everything here takes the roster it is asked about and
 * answers from it, so it is testable without React and can never disagree with the server.
 */

/**
 * The chip's colour class. `attention` is the one a reader must act on — Home Assistant's
 * "needs attention" — and it is the whole content of the attention filter: a row needs
 * attention if and only if its status carries this tone.
 */
export type StatusTone = "on" | "off" | "busy" | "attention";

export interface PluginStatus {
  /** One or two plain words for the chip: On, Off, Starting, Crashed, Refused, Not ready. */
  readonly word: string;
  readonly tone: StatusTone;
  /** The reason behind the word, when there is one worth saying; a tooltip and a card line. */
  readonly why: string | null;
}

/**
 * Why an INSTALLED bundle could not serve at boot (ADR 0016 R8). The class is the door's;
 * the sentence is the row's — "nothing from its bundle was loaded" is the consequence every
 * one of them shares, said once by the caller.
 */
const INSTALL_REFUSAL_WORDS: Readonly<Record<PluginInstallRefusal, string>> = {
  artifact_unreadable: "its bundle could not be read",
  artifact_invalid: "its bundle is not one this engine reads",
  hash_mismatch: "its bundle no longer matches its hash",
  already_installed: "another bundle is installed under its id",
  not_installed: "its install record is gone",
  namespace_reserved: "its id claims a namespace only the build may",
  still_enabled: "it was still on",
  storage_retained: "its stored data has not been purged",
  no_entry: "its bundle names nothing to run",
  stylesheet_unscoped: "its stylesheet reaches past its own root class",
};

/**
 * The same classes as the INSTALL DOOR answers them, at the moment somebody presses Install
 * (`{ refused: "<class>: detail" }`, `docs/PLUGINS.md` §Installing a plugin). A different
 * moment from the boot table above — "no longer matches its hash" is a bundle that changed on
 * disk; "does not hash to the sha256 you pinned" is a form somebody just filled in — so the
 * two tables share a key set and not a voice. Total over the closed set, like the first.
 */
const INSTALL_DOOR_WORDS: Readonly<Record<PluginInstallRefusal, string>> = {
  artifact_unreadable: "The bundle could not be read",
  artifact_invalid: "The bundle is not one this engine reads",
  hash_mismatch: "The bytes do not hash to the sha256 you pinned",
  already_installed: "That id is already installed at another hash",
  not_installed: "Nothing is installed under that id",
  namespace_reserved: "That id claims a namespace only the build may",
  still_enabled: "Switch it off first",
  storage_retained: "Purge its retained data before uninstalling",
  no_entry: "The bundle names nothing to run",
  stylesheet_unscoped: "The stylesheet reaches past the plugin's own root class",
};

/**
 * An install door's denial message in words: the class prefix becomes a sentence and the
 * door's own detail follows it, so "artifact_unreadable: Unable to connect" reads "The bundle
 * could not be read — Unable to connect". A message with no known class is returned as it
 * came, because a sentence this module did not write is still better than none.
 */
export function installRefusalWords(message: string): string {
  const split = message.indexOf(": ");
  if (split === -1) return message;
  const reason = PLUGIN_INSTALL_REFUSALS.find((candidate) => candidate === message.slice(0, split));
  if (reason === undefined) return message;
  const detail = message.slice(split + 2);
  return detail === "" ? INSTALL_DOOR_WORDS[reason] : `${INSTALL_DOOR_WORDS[reason]} — ${detail}`;
}

/**
 * Why a row cannot be toggled right now, when the roster cannot name the plugins involved.
 * Two of these are refined below with names read off the roster (`dependency_disabled`,
 * `incompatible_dependency`); the rest are total fallbacks so no class ever prints as itself.
 */
const REFUSAL_WORDS: Readonly<Record<PluginRefusalReason, string>> = {
  essential: "essential: the workspace cannot be drawn without it",
  builtin: "an engine door: the thing that would switch it off is itself",
  unknown_plugin: "no plugin answers to its id",
  missing_dependency: "plugins that require it are on",
  incompatible_dependency: "shares the workspace with a plugin that declares it incompatible",
  dependency_disabled: "needs a plugin that is off",
  data_downgrade: "its stored data is newer than its code",
  data_migration_missing: "its stored data needs a migration this build does not carry",
  element_type_owned: "another plugin owns an element type it declares",
  still_enabled: "it is still on",
  developer_mode_off: "unpacked: developer mode is off",
  stylesheet_unscoped: "its stylesheet reaches past its own root class",
};

/** The two lifecycle failures that are not a status word of their own, as sentences. */
const LIFECYCLE_WORDS: Readonly<Record<Exclude<PluginLifecycleState, "ok">, string>> = {
  enable_failed: "its startup hook failed: it is on, but may not be ready",
  disable_failed: "its shutdown hook failed: it is off regardless",
  isolate_starting: "its process is starting; its doors answer once it reports in",
  isolate_crashed: "its process crashed past the restart budget; switch it off and on to try again",
};

/** Ids joined the way a sentence lists them: "a", "a and b", "a, b and c". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** The `required` dependencies of `entry` that are composed but OFF — what an enable must name. */
export function offDependencies(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): readonly string[] {
  const declared = entry.manifest.dependencies ?? {};
  return Object.entries(declared)
    .filter(([target, dependency]) => {
      if (dependency?.type !== "required") return false;
      const row = roster.find((candidate) => candidate.manifest.id === target);
      return row !== undefined && !row.enabled;
    })
    .map(([target]) => target)
    .sort();
}

/** Enabled plugins declared incompatible with `entry`, in either direction. */
export function incompatibleWith(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): readonly string[] {
  const id = entry.manifest.id;
  const declaredHere = Object.entries(entry.manifest.dependencies ?? {})
    .filter(([target, dependency]) => {
      if (dependency?.type !== "incompatible") return false;
      const row = roster.find((candidate) => candidate.manifest.id === target);
      return row !== undefined && row.enabled;
    })
    .map(([target]) => target);
  const declaredThere = roster
    .filter(
      (row) =>
        row.manifest.id !== id &&
        row.enabled &&
        row.manifest.dependencies?.[id]?.type === "incompatible",
    )
    .map((row) => row.manifest.id);
  return [...new Set([...declaredHere, ...declaredThere])].sort();
}

/**
 * A refusal class as a sentence, with the plugins it is about named where the roster can
 * name them. `dependency_disabled` and `incompatible_dependency` are the two a reader can DO
 * something about — turn that one on, turn that one off — so the sentence says which one.
 */
export function refusalWords(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
  reason: PluginRefusalReason,
): string {
  switch (reason) {
    case "dependency_disabled": {
      const off = offDependencies(roster, entry);
      return off.length === 0 ? REFUSAL_WORDS[reason] : `needs ${listNames(off)} on`;
    }
    case "incompatible_dependency": {
      const clashes = incompatibleWith(roster, entry);
      return clashes.length === 0
        ? REFUSAL_WORDS[reason]
        : `shares the workspace with ${listNames(clashes)}, which ${
            clashes.length === 1 ? "declares" : "declare"
          } it incompatible`;
    }
    case "essential":
    case "builtin":
    case "unknown_plugin":
    case "missing_dependency":
    case "data_downgrade":
    case "data_migration_missing":
    case "element_type_owned":
    case "still_enabled":
    case "developer_mode_off":
    case "stylesheet_unscoped":
      return REFUSAL_WORDS[reason];
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * THE STATUS, by precedence. The order is "what would a reader most want to know first":
 * an assembly hold or a bundle the engine refused to load outranks anything its lifecycle says
 * (nothing ran); a crashed or starting process outranks a hook's outcome; a hook
 * failure outranks the plain on/off answer; and a refusal on an ENABLED row (an incompatible
 * peer) is attention, while a refusal on a DISABLED row (`dependency_disabled`) is merely the
 * reason the toggle is inert — the row is off exactly as its administrator left it, and
 * painting that red would tell everyone something is wrong when nothing is.
 */
export function pluginStatus(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): PluginStatus {
  if (entry.held !== undefined) {
    const incompatibilities = entry.install?.compatibility?.issues.filter(
      (issue) => issue.kind === "incompatible",
    );
    return {
      word: "Held",
      tone: "attention",
      why:
        entry.held.reason === "repack_required"
          ? incompatibilities !== undefined && incompatibilities.length > 0
            ? `Repack for this hub: ${incompatibilities.map((issue) => `${issue.component} built ${issue.built ?? "unknown"}, hub ${issue.current}`).join("; ")}. No code from this bundle was loaded.`
            : `Repack this bundle once with plugin-kit hardened contract ${String(entry.held.minimum)} or a newer accepted contract; no code from this bundle was loaded.`
          : entry.held.reason,
    };
  }
  const installRefusal = entry.install?.refusal;
  if (installRefusal !== undefined) {
    return {
      word: "Refused",
      tone: "attention",
      why: `${INSTALL_REFUSAL_WORDS[installRefusal]}, so nothing from it was loaded`,
    };
  }
  switch (entry.lifecycle) {
    case "isolate_crashed":
      return { word: "Crashed", tone: "attention", why: LIFECYCLE_WORDS.isolate_crashed };
    case "isolate_starting":
      return { word: "Starting", tone: "busy", why: LIFECYCLE_WORDS.isolate_starting };
    case "enable_failed":
      return { word: "Not ready", tone: "attention", why: LIFECYCLE_WORDS.enable_failed };
    case "disable_failed":
      return { word: "Off", tone: "attention", why: LIFECYCLE_WORDS.disable_failed };
    case "ok":
    case undefined:
      break;
    default: {
      const exhaustive: never = entry.lifecycle;
      return exhaustive;
    }
  }
  const refusal = entry.refusal;
  if (entry.enabled) {
    if (refusal === "incompatible_dependency") {
      return { word: "On", tone: "attention", why: refusalWords(roster, entry, refusal) };
    }
    return {
      word: "On",
      tone: "on",
      why: refusal === undefined ? null : refusalWords(roster, entry, refusal),
    };
  }
  return {
    word: "Off",
    tone: "off",
    why: refusal === undefined ? null : refusalWords(roster, entry, refusal),
  };
}

/** The attention filter's predicate, so the chip's colour and the filter can never disagree. */
export function needsAttention(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): boolean {
  return pluginStatus(roster, entry).tone === "attention";
}

/**
 * What each capability LETS a holder do, in one line. Keyed by the protocol's closed cap set
 * (`CAPS`, `packages/protocol/src/capabilities.ts`), so a tenth cap cannot ship without a
 * sentence here — a permissions card that listed `scenes:write` and left the reader to guess
 * what a scene is would be a card that named the enum.
 */
export const CAP_MEANINGS: Readonly<Record<Cap, string>> = {
  "*": "Everything: root authority over the whole workspace",
  "containers:read": "Read containers and what is inside them",
  "containers:write": "Create, rename, move and delete containers",
  "scenes:write": "Change what is on a canvas",
  "terminals:spawn": "Open terminals on a machine",
  "terminals:write": "Type into terminals",
  "tokens:mint": "Mint tokens: hand authority to others",
  "machines:mint": "Enroll machines into the fleet",
  "agents:delegate": "Register bounded Agents and delegate child Runs",
  "agents:run": "Admit Runs for one registered Agent within its standing grant",
  "machines:read": "Read what an enrolled machine reports about its own host",
  "machines:run": "Run admitted machine operations with explicit version-bound consent",
  "jobs:read": "Read admitted jobs and their outputs",
  "jobs:input": "Provide input to admitted jobs",
  "jobs:cancel": "Cancel admitted jobs",
  "services:read": "Read explicitly admitted service metadata",
  "services:invoke": "Invoke explicitly admitted service operations",
  "services:configure": "Configure machine service policies as the root owner",
  "locations:read": "Read an explicitly admitted location",
  "locations:write": "Write an explicitly admitted location",
  "locations:create": "Create entries in an explicitly admitted location",
  "locations:create-child":
    "Exclusively create a regular-file child in an explicitly admitted managed root; never overwrite, suffix, delete or write arbitrary directory contents",
  "operations:invoke": "Invoke an explicitly admitted operation",
  "network:host": "Use explicitly admitted host networking",
  "plugins:manage": "Turn plugins on and off for everyone",
};

export function highRiskRuntimeRight(cap: Cap): boolean {
  return (
    cap === "network:host" ||
    cap === "locations:write" ||
    cap === "locations:create" ||
    cap === "locations:create-child"
  );
}

/** Exact declared location rights, not every location and never an implied read grant. */
export function machineLocationRights(machineId: string, machine: MachineHalf) {
  const rights = new Map<string, { node: string; cap: Cap; label: string }>();
  const add = (locationId: string, access: "read" | "write" | "create" | "create-child") => {
    const node = formatManifoldUri({ kind: "location", machineId, locationId });
    const cap = `locations:${access}` as const;
    rights.set(`${node}:${cap}`, { node, cap, label: `${access} ${locationId}` });
  };
  for (const operation of Object.values(machine.operations))
    for (const location of operation.locations) add(location.locationId, location.access);
  for (const [locationId, access] of Object.entries(machine.transferPolicy?.locations ?? {}))
    for (const right of access) add(locationId, right);
  return [...rights.values()];
}

/**
 * What a PLUGIN'S OWN capability lets a holder do, in the only words the engine honestly has
 * (ADR 0035). `CAP_MEANINGS` above is keyed by the engine's closed set and a tenth engine cap
 * still cannot ship without a sentence there; a namespaced name is the PLUGIN's word, declared
 * in its manifest, and the engine knows nothing about it beyond whose it is. So the card says
 * what is true of every one of them — the authority is the plugin's own, and it is held at a
 * node rather than carried by a credential — instead of inventing a description of somebody
 * else's vocabulary.
 */
export const PLUGIN_CAP_MEANING =
  "This plugin's own capability: authority over its doors, granted per node";

/** One capability as the permissions card shows it: the cap, its meaning, and how it is held. */
export interface Permission {
  readonly cap: AuthoredCap;
  readonly meaning: string;
  /** `withheld` only on an installed row whose installer withheld this declared cap. */
  readonly state: PermissionState;
  /** True only for `granted`: what the row can exercise on its grant alone. */
  readonly granted: boolean;
}

/**
 * THE PERMISSIONS a row holds, as the chip counts them and the card lists them.
 *
 * A first-party row holds exactly what its manifest declares — the ceiling assembly checks
 * every action against (ADR 0023 §8). An installed row holds its GRANT (`install.grantedCaps`,
 * the installer's consent, enforced at rung 4 before the caller's own caps), and the card
 * shows the declared caps the installer withheld greyed beside it, because "this plugin asked
 * for more than it was given" is the sentence an operator reads a grant for. Wildcard ceilings
 * expand to engine capabilities, so a narrowed named grant is never hidden behind `*`.
 *
 * THREE STATES, NOT TWO. A governed capability is never in any grant — `grantFor` filters
 * `GOVERNED_CAPS` out of the default grant AND out of an explicit installer grant, because
 * governed authority is discharged per node, bound to an artifact revision, by consent. Shown
 * as `withheld` it reads as an installer's refusal, which is the sentence an operator acted on
 * for a day: nine declared, three granted, and the conclusion that the install had dropped six
 * when in truth six are governed and one door was asking the wrong question (#733, #735).
 */
export type PermissionState = "granted" | "withheld" | "governed";

function permissionRows(
  declared: readonly AuthoredCap[],
  granted: readonly AuthoredCap[] | null,
): Permission[] {
  const domain = new Set(declared);
  if (declared.includes("*")) {
    for (const cap of CAPS) domain.add(cap);
  }
  return [...domain].map((cap) => {
    const state: PermissionState = GOVERNED_CAPS.includes(cap)
      ? "governed"
      : granted === null || (cap === "*" ? granted.includes("*") : hasCap(granted, cap))
        ? "granted"
        : "withheld";
    return {
      cap,
      meaning: isEngineCap(cap) ? CAP_MEANINGS[cap] : PLUGIN_CAP_MEANING,
      state,
      granted: state === "granted",
    };
  });
}

export function pluginPermissions(entry: PluginRosterEntry): readonly Permission[] {
  return permissionRows(entry.manifest.capabilities, entry.install?.grantedCaps ?? null);
}

/** The chip's number: what the row can actually do — its grant, or its declaration. */
export function permissionCount(entry: PluginRosterEntry): number {
  return pluginPermissions(entry).filter((permission) => permission.granted).length;
}

/**
 * The permissions chip's tooltip. Lists the caps rather than counting them, because the count
 * is on the chip already; for an installed row it leads with the declared-versus-granted
 * fraction, which is the one number an installer's consent reduces to — and it names the
 * governed ones separately, because an installer withheld nothing there.
 */
export function permissionSummary(entry: PluginRosterEntry): string {
  const permissions = pluginPermissions(entry);
  if (permissions.length === 0) return "Declares no capabilities";
  const named = (state: PermissionState): string[] =>
    permissions.filter((permission) => permission.state === state).map((p) => p.cap);
  const held = named("granted");
  const withheld = named("withheld");
  const governed = named("governed");
  if (entry.install === undefined)
    return `Declares ${permissions.map((permission) => permission.cap).join(", ")}`;
  const clauses = [
    `Granted ${String(held.length)} of ${String(permissions.length)} declared${
      held.length === 0 ? ": nothing" : `: ${held.join(", ")}`
    }`,
    ...(governed.length === 0
      ? []
      : [`${String(governed.length)} governed by per-node consent: ${governed.join(", ")}`]),
    ...(withheld.length === 0 ? [] : [`withheld ${withheld.join(", ")}`]),
  ];
  return clauses.join("; ");
}

/**
 * WHERE A ROW'S NEXT VERSION COMES FROM (#238), which decides whether the manager may offer an
 * update at all. Only an installed BUNDLE family whose root declares a release source is ever
 * reviewed and applied from here; everything else names its real owner instead of a button:
 *
 *   `engine`    an engine door, changed only by upgrading Manifold itself;
 *   `build`     a plugin compiled into this build (every `core.` seat), proven with it and
 *               released with it — never updated on its own;
 *   `unpacked`  a row this hub builds from its own source tree (ADR 0025 §4) — the tree is the
 *               only way to change it, and no release may take it over;
 *   `unsourced` an installed bundle family whose root declares no release source;
 *   `feed`      an installed bundle family whose root declares `releases`.
 *
 * The FAMILY is the topmost installed dotted-namespace ancestor and everything installed under
 * it — the unit the coordinator reviews and applies — so a part routes to its root, whose
 * `manifest.releases` is the family's source.
 */
export type UpdateOwnership =
  | { readonly kind: "engine" }
  | { readonly kind: "build" }
  | { readonly kind: "unpacked"; readonly root: PluginRosterEntry }
  | { readonly kind: "unsourced"; readonly root: PluginRosterEntry }
  | { readonly kind: "feed"; readonly root: PluginRosterEntry; readonly source: string };

/** Whether `id` is `root` itself or a dotted-namespace descendant of it. */
export function inUpdateFamily(rootId: string, id: string): boolean {
  return id === rootId || id.startsWith(`${rootId}.`);
}

/**
 * The installed row a family is reviewed under: the shortest dotted-namespace prefix of the
 * row's id that is itself an installed row, or the row itself. Null for a row nobody installed
 * (an engine door or a compiled seat), which has no family to update.
 */
export function updateFamilyRoot(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): PluginRosterEntry | null {
  if (entry.install === undefined || entry.source === "builtin") return null;
  const segments = entry.manifest.id.split(".");
  for (let length = 2; length < segments.length; length += 1) {
    const prefix = segments.slice(0, length).join(".");
    const ancestor = roster.find((candidate) => candidate.manifest.id === prefix);
    if (ancestor?.install !== undefined && ancestor.source !== "builtin") return ancestor;
  }
  return entry;
}

export function updateOwnership(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): UpdateOwnership {
  if (entry.source === "builtin") return { kind: "engine" };
  const root = updateFamilyRoot(roster, entry);
  if (root === null || entry.manifest.id.startsWith(CORE_NAMESPACE_PREFIX)) {
    return { kind: "build" };
  }
  if (entry.install?.mode === "unpacked") return { kind: "unpacked", root: entry };
  if (root.install?.mode === "unpacked") return { kind: "unpacked", root };
  const source = root.manifest.releases;
  return source === undefined ? { kind: "unsourced", root } : { kind: "feed", root, source };
}

/**
 * WHY A HELD REVIEW NO LONGER DESCRIBES WHAT IS INSTALLED, read off the published roster: a
 * member's pin or on/off state moved, a member was uninstalled, a part the review would add
 * was installed meanwhile, or an installed bundle joined the family. Unpacked rows are their
 * source tree's, never a member, so one appearing is not a family change. Empty ≡ still current
 * as far as this client can see; the coordinator re-checks everything (grants, data versions,
 * native state) at apply and refuses `review_stale` on its own evidence.
 */
export function reviewStaleness(
  roster: readonly PluginRosterEntry[],
  review: PluginUpdateReview,
): readonly string[] {
  const reasons: string[] = [];
  const reviewed = new Set(review.members.map((member) => member.id));
  for (const member of review.members) {
    const row = roster.find((candidate) => candidate.manifest.id === member.id);
    if (member.current === null) {
      if (row?.install !== undefined) reasons.push(`${member.id} was installed since the review`);
      continue;
    }
    if (row?.install === undefined) {
      reasons.push(`${member.id} is no longer installed`);
    } else if (row.install.sha256 !== member.current.sha256) {
      reasons.push(`${member.id} now runs different bytes`);
    } else if (row.enabled !== member.current.enabled) {
      reasons.push(`${member.id} was switched ${row.enabled ? "on" : "off"}`);
    }
  }
  for (const row of roster) {
    if (
      row.install !== undefined &&
      row.install.mode !== "unpacked" &&
      row.source !== "builtin" &&
      inUpdateFamily(review.rootId, row.manifest.id) &&
      !reviewed.has(row.manifest.id)
    ) {
      reasons.push(`${row.manifest.id} joined the family`);
    }
  }
  return reasons;
}

/** The members whose capability CEILING grows: each needs its own explicit acknowledgement. */
export function expandingMembers(review: PluginUpdateReview): readonly PluginUpdateMember[] {
  return review.members.filter((member) => member.capabilitiesAdded.length > 0);
}

/**
 * THE CONSENT an apply carries: exactly each expanding member's added capabilities, and only
 * once every one of them has been acknowledged. Null while any is not — the coordinator
 * refuses a missing, extra or partial consent rather than withholding silently, so the button
 * stays shut instead of sending a request that can only be refused. A member with nothing
 * added is never named: there is nothing of it to consent to.
 */
export function updateConsent(
  review: PluginUpdateReview,
  acknowledged: ReadonlySet<string>,
): PluginUpdateApplyRequest["consent"] | null {
  const expanding = expandingMembers(review);
  if (expanding.some((member) => !acknowledged.has(member.id))) return null;
  return expanding.map((member) => ({
    id: member.id,
    capabilities: [...member.capabilitiesAdded],
  }));
}

/**
 * Why an apply's own record does NOT describe the review it answered, or null when it does:
 * the same family, only reviewed parts, each at exactly its reviewed version and bytes, and
 * every part whose bytes the review changes accounted for. A part the review leaves unchanged
 * may be named or omitted — the installer skips a pin that does not move.
 */
export function appliedMismatch(
  review: PluginUpdateReview,
  result: PluginUpdateApplyResult,
): string | null {
  if (result.rootId !== review.rootId) return `it names ${result.rootId}, not ${review.rootId}`;
  for (const installed of result.installed) {
    const member = review.members.find((candidate) => candidate.id === installed.id);
    if (member === undefined) return `${installed.id} was not part of this review`;
    if (
      member.candidate.sha256 !== installed.sha256 ||
      member.candidate.version !== installed.version
    ) {
      return `${installed.id} is not the reviewed ${member.candidate.version}`;
    }
  }
  const missing = review.members.find(
    (member) =>
      member.current?.sha256 !== member.candidate.sha256 &&
      !result.installed.some((installed) => installed.id === member.id),
  );
  return missing === undefined ? null : `it does not account for ${missing.id}`;
}

/** One capability of a candidate, as the review lists it. */
export interface UpdatePermission {
  readonly cap: AuthoredCap;
  readonly meaning: string;
  /**
   * What the row holds AFTER the update, with every shown addition acknowledged: `granted`
   * rides its grant, `withheld` is declared but not granted (an old withholding survives an
   * update), `governed` never rides a grant and is consented per node.
   */
  readonly state: PermissionState;
  /** New to the ceiling in this update — what the acknowledgement is about. */
  readonly added: boolean;
}

export function updatePermissions(member: PluginUpdateMember): readonly UpdatePermission[] {
  const added = new Set<AuthoredCap>(member.capabilitiesAdded);
  return permissionRows(member.candidate.capabilities, member.grantedCaps).map((permission) => ({
    ...permission,
    added:
      added.has(permission.cap) ||
      (added.has("*") &&
        permission.cap !== "*" &&
        isEngineCap(permission.cap) &&
        !hasCap(member.current?.capabilities ?? [], permission.cap)),
  }));
}

/** One declared relationship that differs between the installed and the candidate manifest. */
export interface DependencyChange {
  readonly id: string;
  readonly before: PluginDependency | null;
  readonly after: PluginDependency | null;
}

/** The relationships a candidate adds, drops or retypes, by id; unchanged ones are omitted. */
export function dependencyChanges(
  before: PluginDependencyMap | null,
  after: PluginDependencyMap,
): readonly DependencyChange[] {
  const ids = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();
  return ids.flatMap((id) => {
    const was = before?.[id] ?? null;
    const now = after[id] ?? null;
    if (was?.type === now?.type && was?.reason === now?.reason) return [];
    return [{ id, before: was, after: now }];
  });
}

/** The halves a bundle can carry, in the words the review uses. */
export const PLUGIN_HALVES = ["web", "server", "machine", "styles"] as const;
export type PluginHalf = (typeof PLUGIN_HALVES)[number];
export const PLUGIN_HALF_LABELS: Readonly<Record<PluginHalf, string>> = {
  web: "Web half",
  server: "Server half",
  machine: "Machine half",
  styles: "Stylesheet",
};

/** Executable halves and stylesheet declared by the reviewed artifact. */
export function hasHalf(description: PluginUpdateMember["candidate"], half: PluginHalf): boolean {
  switch (half) {
    case "web":
      return description.entry.web !== undefined;
    case "server":
      return description.entry.server === true;
    case "machine":
      return description.machine;
    case "styles":
      return description.entry.styles === true;
    default: {
      const exhaustive: never = half;
      return exhaustive;
    }
  }
}

/**
 * The update doors' refusal classes (`{ refused: "<class>: detail" }`), as sentences. Artifact
 * and ownership classes the updater shares with the install door fall through to that door's
 * words, and a message with no known class is returned as it came.
 */
const UPDATE_REFUSAL_WORDS: Record<PluginUpdateRefusal, string> = {
  review_stale: "The installed family changed since this review",
  review_expired: "This review expired",
  review_missing: "The hub no longer holds this review",
  consent_required: "Each capability expansion must be acknowledged exactly as reviewed",
  update_blocked: "This update is blocked",
  update_unavailable: "No update can be reviewed for this family",
  update_failed: "The update could not be completed",
} as const;
type UpdateRefusal = keyof typeof UPDATE_REFUSAL_WORDS;

function isUpdateRefusal(candidate: string): candidate is UpdateRefusal {
  return Object.hasOwn(UPDATE_REFUSAL_WORDS, candidate);
}

export function updateRefusalWords(message: string): string {
  const split = message.indexOf(": ");
  const reason = split === -1 ? message : message.slice(0, split);
  if (!isUpdateRefusal(reason)) return installRefusalWords(message);
  const detail = split === -1 ? "" : message.slice(split + 2);
  return detail === ""
    ? UPDATE_REFUSAL_WORDS[reason]
    : `${UPDATE_REFUSAL_WORDS[reason]} — ${detail}`;
}

/** A data version as the review prints it. */
export function dataVersionWords(version: {
  readonly major: number;
  readonly minor: number;
}): string {
  return `v${String(version.major)}.${String(version.minor)}`;
}

/** The host of a URL, for a link's visible text; the whole URL is the reader's on hover. */
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
