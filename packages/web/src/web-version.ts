import { BuildChannelSchema, type BuildChannel } from "@manifold/protocol";
import type { WebChangelogRelease } from "@manifold/plugin/hooks";
import { GENERATED_WEB_CHANGELOG } from "./generated-changelog.ts";

/*
 * RELEASE METADATA, and it stays FLOOR: the version is injected into this bundle by the web
 * package's own build (`vite.config.ts`) and the history is generated from `CHANGELOG.md` by
 * the release path, so neither is a plugin's data even though the shell's sidebar panel is what
 * prints them. The panel reads both off the `WorkspaceShell` context the floor publishes.
 *
 * The release SHAPE is declared in `@manifold/plugin` rather than here, because the producer is
 * floor and the consumer is a plugin and a second spelling of one shape is the drift invariant
 * 14 forbids.
 */

export const WEB_VERSION =
  import.meta.env.VITE_MANIFOLD_WEB_VERSION ?? GENERATED_WEB_CHANGELOG[0]?.version ?? "0.0.0-dev";
/** `version` at a release, `<version>+<distance>.g<sha7>` past one — the same string `/healthz` answers. */
export const WEB_BUILD: string = import.meta.env.VITE_MANIFOLD_WEB_BUILD ?? WEB_VERSION;
export const WEB_CHANNEL: BuildChannel = BuildChannelSchema.catch("development").parse(
  import.meta.env.VITE_MANIFOLD_WEB_CHANNEL,
);
/*
 * A development build SAYS so wherever its build is printed, because the build string alone
 * ("0.6.2+21.gb7a07fe") asks the reader to know the grammar; the word does not. The word LEADS:
 * the rail's rev line truncates from the right, and the sha is what a narrow rail may lose,
 * never the fact that this is not a release.
 */
export const WEB_VERSION_LABEL =
  WEB_CHANNEL === "development" ? `development · v${WEB_BUILD}` : `v${WEB_BUILD}`;

export const WEB_CHANGELOG: readonly WebChangelogRelease[] = GENERATED_WEB_CHANGELOG;
