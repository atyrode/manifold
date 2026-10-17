// The Layers section of a composed scene (README "Layers in the lab", rules in layers-model.ts): its
// layer switches (Widget `layer`) as a row per role, in role order, each layer a chip of the
// group's kind (chips.ts: a feature's amount on its chip or under the row) that is on, off, or
// refused: switched on and not drawn, dimmed, the placer's reason in its title and under its row.
// A backdrop's or a ground's chip swaps for the one of its role, the backdrop on stays on, and
// switching a layer on switches off what it excludes. Laid out from the scene's metadata
// (SceneDef.layers), never from scene ids.
import type { SceneLayers } from "../composer/compose.ts";
import { chipGrid } from "./chips.ts";
import { h, setHidden, setText, type Built } from "./dom.ts";
import type { Knobs, SwitchDef } from "./knobs.ts";
import { layerRows, layerTurn, ROLE_LABEL } from "./layers-model.ts";

/** The Layers section for `switches`, the layer switches of `layers` the group holds. */
export function layersSection(
  knobs: Knobs,
  layers: SceneLayers,
  switches: readonly SwitchDef[],
): Built {
  const value = (key: string) => knobs.value(key);
  const titles = new Map(layers.offered.map((layer) => [layer.id, layer.title]));
  /** Why each layer switched on is not drawn, as the setup stands (worked out once per sync). */
  const refusals = () =>
    new Map(
      layerRows(layers, value).flatMap((row) =>
        row.layers.flatMap(({ id, state }) =>
          state.kind === "refused" ? [[id, state.reason] as const] : [],
        ),
      ),
    );
  let refused = refusals();
  const options = {
    turn: (def: SwitchDef, on: boolean) => layerTurn(layers, value, def.key, on),
    refusal: (def: SwitchDef) => refused.get(def.key),
  };
  const rows = layerRows(layers, value).map((row) => {
    const defs = row.layers.flatMap(({ id }) => switches.filter((def) => def.key === id));
    const chips = chipGrid(knobs, defs, options);
    const label = ROLE_LABEL[row.role];
    const note = h("p", { class: "layer-refusals", hidden: true });
    const el = h(
      "div",
      { class: "layer-row", role: "group", "aria-label": label, "data-role": row.role },
      h("span", { class: "layer-role" }, label),
      chips.grid.el,
      chips.amounts.el,
      note,
    );
    return { defs, chips, note, el };
  });

  return {
    el: h("div", { class: "layer-rows" }, ...rows.map((row) => row.el)),
    sync: () => {
      refused = refusals();
      for (const { defs, chips, note } of rows) {
        chips.grid.sync();
        chips.amounts.sync();
        const words = defs.flatMap((def) => {
          const reason = refused.get(def.key);
          return reason === undefined ? [] : [`${titles.get(def.key) ?? def.label}: ${reason}`];
        });
        setText(note, words.join(" · "));
        setHidden(note, words.length === 0);
      }
    },
  };
}
