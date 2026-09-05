import { ui } from "@manifold/plugin-kit";
import { definePanel, defineWebPlugin, type GuestHost } from "@manifold/plugin-kit/web";
import type { UiNode } from "@manifold/protocol";
import { z } from "zod";

/*
  THE REFERENCE ISOLATED PLUGIN, web half. One panel, `counter`, written as a program over its
  own state: `init` asks the host who is looking, `view` projects the state into the closed
  vocabulary — every one of its thirteen kinds appears below on purpose — and `update` folds
  a named callback into the next state, dispatching `example.counter.bump` through the host when
  the button fires. Nothing here touches a DOM; the engine paints the tree.
 */

interface CounterState {
  readonly viewer: string;
  readonly count: number | null;
  readonly step: number;
  readonly note: string;
  readonly loud: boolean;
  readonly denial: string | null;
  readonly ticks: number;
}

const BumpResult = z.object({ count: z.number().int() });

export const counter = definePanel<CounterState>({
  init: (host: GuestHost) => ({
    viewer: host.principal.name,
    count: null,
    step: 1,
    note: "",
    loud: false,
    denial: null,
    ticks: 0,
  }),
  view: (state): UiNode =>
    ui.box({ direction: "column", gap: 2 }, [
      ui.heading("Counter", 2),
      ui.text(`Hello, ${state.viewer}.`, { tone: "muted" }),
      ui.divider(),
      state.count === null
        ? ui.spinner("Waiting for the first bump")
        : ui.badge(`count ${String(state.count)}`, state.loud ? "accent" : "neutral"),
      ui.select(
        "step",
        String(state.step),
        [
          { value: "1", label: "by one" },
          { value: "5", label: "by five" },
        ],
        { label: "Step" },
      ),
      ui.input("note", state.note, { label: "Note", placeholder: "why this bump?" }),
      ui.toggle("loud", state.loud, "Loud"),
      ui.button("Bump", "bump", { tone: "accent", action: "example.counter.bump" }),
      state.denial === null
        ? ui.empty("No refusal yet.")
        : ui.text(state.denial, { tone: "danger" }),
      ui.code(JSON.stringify({ ticks: state.ticks }, null, 2)),
      ui.list([{ key: "ticks", primary: "Ticks", secondary: String(state.ticks) }]),
    ]),
  update: async (state, event, host) => {
    switch (event.event) {
      case "step":
        return { ...state, step: Number(event.payload) };
      case "note":
        return { ...state, note: String(event.payload) };
      case "loud":
        return { ...state, loud: event.payload === true };
      case "tick":
        return { ...state, ticks: state.ticks + 1 };
      case "bump": {
        const outcome = await host.action("example.counter.bump", { by: state.step });
        if (!outcome.ok) return { ...state, denial: outcome.denial.message };
        return { ...state, count: BumpResult.parse(outcome.result).count, denial: null };
      }
      default:
        return state;
    }
  },
  subscribe: (_host, emit) => {
    const timer = setInterval(() => emit({ event: "tick" }), 60_000);
    return () => clearInterval(timer);
  },
});

defineWebPlugin({ id: "example.counter", panels: { counter } });
