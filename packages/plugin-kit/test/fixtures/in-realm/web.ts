import { createElement, useState } from "react";
import { Stack } from "@manifold/ui";
import { panelRefId } from "@manifold/plugin";

/**
 * A live React panel; packing shares the shell's React and UI rather than copying either. Its
 * skin is `styles.css` beside it, every rule rooted at `.plugin-example_counter` — the class
 * the panel's own root wears, which is the whole of what the hub admits a sheet for (#258).
 */
function Counter() {
  const [count, setCount] = useState(0);
  return createElement(
    Stack,
    { gap: "0.5rem", className: "plugin-example_counter" },
    createElement("h2", null, "Example counter"),
    createElement(
      "output",
      {
        id: panelRefId("example.counter", "counter"),
        className: "plugin-example_counter__count",
        "data-testid": "in-realm-counter",
        "aria-live": "polite",
      },
      String(count),
    ),
    createElement(
      "button",
      { type: "button", onClick: () => setCount((value) => value + 1) },
      "Increment",
    ),
  );
}

export default {
  id: "example.counter",
  panels: { counter: Counter },
};
