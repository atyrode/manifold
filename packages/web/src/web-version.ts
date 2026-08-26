import { GENERATED_WEB_CHANGELOG } from "./generated-changelog.ts";

export interface WebChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly string[];
}

export const WEB_VERSION =
  import.meta.env.VITE_MANIFOLD_WEB_VERSION ?? GENERATED_WEB_CHANGELOG[0]?.version ?? "0.0.0-dev";
export const WEB_BUILD = import.meta.env.VITE_MANIFOLD_WEB_BUILD ?? "local";
export const WEB_VERSION_LABEL = `v${WEB_VERSION} · ${WEB_BUILD}`;

export const WEB_CHANGELOG: readonly WebChangelogRelease[] = GENERATED_WEB_CHANGELOG;
