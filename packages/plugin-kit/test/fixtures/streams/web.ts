import { ui } from "@manifold/plugin-kit";
import { definePanel, defineWebPlugin } from "@manifold/plugin-kit/web";
import { z } from "zod";

const Progress = z.strictObject({ seq: z.number().int().nonnegative(), status: z.string() });
type Progress = z.infer<typeof Progress>;

const frames = definePanel<Progress>({
  init: () => ({ seq: 0, status: "opening" }),
  view: (state) =>
    ui.box({ direction: "column", gap: 2 }, [
      ui.heading("Continuous stream fixture", 2),
      ui.text(`Stream frame ${state.seq}`),
      ui.text(`Stream status ${state.status}`),
    ]),
  update: (state, event) => (event.event === "progress" ? Progress.parse(event.payload) : state),
  subscribe(host, emit) {
    const handle = host.openStream({
      kind: "example.streams.frames",
      node: { kind: "plugin", pluginId: "example.streams" },
    });
    const off = handle.on(() => {
      emit({ event: "progress", payload: { seq: handle.cursor?.seq ?? 0, status: handle.status } });
    });
    return () => {
      off();
      handle.close();
    };
  },
});

defineWebPlugin({ id: "example.streams", panels: { frames } });
