// Saved lab setups. `commit` is the build the setup was tuned on: `/@<commit>/?<query>` replays it
// exactly even after shader logic changes; loading it on a newer build applies the same knobs.
// Add entries from the lab's "export" output.

export interface Preset {
  name: string;
  commit: string;
  query: string;
  savedAt: string;
}

export const presets: readonly Preset[] = [
  {
    name: "orbit · red ign (baseline)",
    commit: "db4ca2e8",
    query: "scene=orbit&dither=ign&levels=4&motion=0.45&accent=%23ff004e",
    savedAt: "2026-10-13",
  },
];
