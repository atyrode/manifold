export interface WebChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly string[];
}

export const WEB_VERSION = import.meta.env.VITE_MANIFOLD_WEB_VERSION ?? "0.0.0-dev";
export const WEB_BUILD = import.meta.env.VITE_MANIFOLD_WEB_BUILD ?? "local";
export const WEB_VERSION_LABEL = `v${WEB_VERSION} · ${WEB_BUILD}`;

export const WEB_CHANGELOG: readonly WebChangelogRelease[] = [
  {
    version: WEB_VERSION,
    date: "2026-08-26",
    changes: [
      "Added a persistent workspace sidebar for pads, machines, and terminal sessions.",
      "Added multiplayer Excalidraw canvases with presence, viewport memory, and embedded terminals.",
      "Added hold-right-click erasing while preserving the normal short-click canvas menu.",
      "Added this web build identifier and in-app changelog.",
    ],
  },
];
