import { createElement, useState } from "react";
import { Stack } from "@manifold/ui";
import { panelRefId } from "@manifold/plugin";

/** A live React panel; packing shares the shell's React and UI rather than copying either. */
function Counter() {
  const [count, setCount] = useState(0);
  return createElement(
    Stack,
    { gap: "0.5rem" },
    createElement("h2", null, "Example counter"),
    createElement(
      "output",
      {
        id: panelRefId("example.counter", "counter"),
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
