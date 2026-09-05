import {
  PLUGIN_INSTALL_REFUSALS,
  type Cap,
  type PluginInstall,
  type PluginInstallRefusal,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginRefusalReason,
  type PluginRosterEntry,
} from "@manifold/protocol";

/**
 * WHAT A ROW SAYS ABOUT ITSELF, in a human's words (issue #239).
 *
 * The roster carries four facts about a plugin's condition — `enabled`, `lifecycle`, `refusal`
 * and `install.refusal` — each a CLASS from a closed vocabulary, because clients switch on
 * classes and agents branch on them (`packages/protocol/src/plugin.ts`). A reader does not: a
 * chip that says `dependency_disabled` or `hash_mismatch` hands them the enum and makes them
 * decode it. This module is the one place the four facts become ONE status — a word for the
 * chip, a tone for its colour, and a sentence saying why — so the list, the detail sheet and
 * the attention filter all read the same answer.
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
  no_entry: "its bundle names nothing to run",
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
  no_entry: "The bundle names nothing to run",
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
      return REFUSAL_WORDS[reason];
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * THE STATUS, by precedence. The order is "what would a reader most want to know first":
 * a bundle the engine refused to load outranks anything its lifecycle says (there was no
 * lifecycle — nothing ran); a crashed or starting process outranks a hook's outcome; a hook
 * failure outranks the plain on/off answer; and a refusal on an ENABLED row (an incompatible
 * peer) is attention, while a refusal on a DISABLED row (`dependency_disabled`) is merely the
 * reason the toggle is inert — the row is off exactly as its administrator left it, and
 * painting that red would tell everyone something is wrong when nothing is.
 */
export function pluginStatus(
  roster: readonly PluginRosterEntry[],
  entry: PluginRosterEntry,
): PluginStatus {
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
  "plugins:manage": "Turn plugins on and off for everyone",
};

/** One capability as the permissions card shows it: the cap, its meaning, and whether it holds. */
export interface Permission {
  readonly cap: Cap;
  readonly meaning: string;
  /** False only on an installed row whose installer withheld this declared cap. */
  readonly granted: boolean;
}

/**
 * THE PERMISSIONS a row holds, as the chip counts them and the card lists them.
 *
 * A first-party row holds exactly what its manifest declares — the ceiling assembly checks
 * every action against (ADR 0023 §8). An installed row holds its GRANT (`install.grantedCaps`,
 * the installer's consent, enforced at rung 4 before the caller's own caps), and the card
 * shows the declared caps the installer withheld greyed beside it, because "this plugin asked
 * for more than it was given" is the sentence an operator reads a grant for. A grant can
 * never exceed the declaration, so the declared list is the card's whole domain.
 */
export function pluginPermissions(entry: PluginRosterEntry): readonly Permission[] {
  const install = entry.install;
  const granted = install === undefined ? null : new Set<Cap>(install.grantedCaps);
  return entry.manifest.capabilities.map((cap) => ({
    cap,
    meaning: CAP_MEANINGS[cap],
    granted: granted === null || granted.has(cap),
  }));
}

/** The chip's number: what the row can actually do — its grant, or its declaration. */
export function permissionCount(entry: PluginRosterEntry): number {
  return pluginPermissions(entry).filter((permission) => permission.granted).length;
}

/**
 * The permissions chip's tooltip. Lists the caps rather than counting them, because the count
 * is on the chip already; for an installed row it leads with the declared-versus-granted
 * fraction, which is the one number an installer's consent reduces to.
 */
export function permissionSummary(entry: PluginRosterEntry): string {
  const permissions = pluginPermissions(entry);
  if (permissions.length === 0) return "Declares no capabilities";
  const held = permissions.filter((permission) => permission.granted).map((p) => p.cap);
  const withheld = permissions.filter((permission) => !permission.granted).map((p) => p.cap);
  if (entry.install === undefined) return `Declares ${held.join(", ")}`;
  const lead = `Granted ${String(held.length)} of ${String(permissions.length)} declared`;
  if (held.length === 0) return `${lead}: nothing; withheld ${withheld.join(", ")}`;
  return withheld.length === 0
    ? `${lead}: ${held.join(", ")}`
    : `${lead}: ${held.join(", ")}; withheld ${withheld.join(", ")}`;
}

/**
 * ADDITIVE-OPTIONAL FIELDS #238 (step 1) IS LANDING. The manifest gains `links` — where a
 * plugin's code lives, as URLs — on a sibling branch, and the hub's release poll will publish
 * a `latest` version beside an installed row's `install` block. This view is how the manager
 * reads both TODAY without a cast: a `PluginManifest` assigns to `RosterManifest` because the
 * only extra member is optional, and a build where the protocol lacks the field simply reads
 * `undefined` and renders nothing. Delete this view — not the readers — once `PluginManifest`
 * and `PluginInstall` carry the fields themselves.
 */
export interface ManifestLinks {
  readonly repository?: string;
  readonly homepage?: string;
  readonly changelog?: string;
}
export interface RosterManifest extends PluginManifest {
  readonly links?: ManifestLinks;
}
export interface RosterInstall extends PluginInstall {
  /** The newest version the plugin's release feed lists, when the hub has polled one (#238). */
  readonly latest?: string;
}

/** The manifest's declared links, read through the view above. */
export function manifestLinks(manifest: PluginManifest): ManifestLinks {
  const viewed: RosterManifest = manifest;
  return viewed.links ?? {};
}

/** The update an installed row could take, or null while no feed has been polled (#238). */
export function latestVersion(entry: PluginRosterEntry): string | null {
  const install: RosterInstall | undefined = entry.install;
  const latest = install?.latest;
  return latest === undefined || latest === entry.manifest.version ? null : latest;
}

/** The host of a URL, for a link's visible text; the whole URL is the reader's on hover. */
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
