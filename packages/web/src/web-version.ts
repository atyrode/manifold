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
export const WEB_BUILD = import.meta.env.VITE_MANIFOLD_WEB_BUILD ?? "local";
export const WEB_VERSION_LABEL = `v${WEB_VERSION} · ${WEB_BUILD}`;

export const WEB_CHANGELOG: readonly WebChangelogRelease[] = GENERATED_WEB_CHANGELOG;
