// The Controls view's World divider, over the shelf of the scene's shared-world groups (sky,
// weather, birds: `Blurb.shelf`), with the "keep the world" switch: while it is on, a scene picked by
// hand opens under the world of the one left (world-model.ts `carryWorld`, applied in lab.ts).
import { h, type Built } from "./dom.ts";
import { icon } from "./icons.ts";

/** The preference the switch keeps (lab/prefs.ts `keepWorld`), and how to store it. */
export interface KeepWorld {
  keepWorld: boolean;
  save(): void;
}

export function worldDivider(prefs: KeepWorld): Built {
  const keep = h(
    "button",
    {
      type: "button",
      class: "world-keep",
      "aria-label": "Keep the world across scenes",
      title:
        "Keep the world: a scene you pick (Scenes, [ ], Next scene) opens under this sky, weather and birds, in this season. Presets, tours and links bring their own.",
    },
    icon("pin"),
    h("span", {}, "keep"),
  );
  const sync = () => keep.setAttribute("aria-pressed", String(prefs.keepWorld));
  keep.addEventListener("click", () => {
    prefs.keepWorld = !prefs.keepWorld;
    prefs.save();
    sync();
  });
  return { el: h("div", { class: "shelf-divider" }, h("span", {}, "World"), keep), sync };
}
