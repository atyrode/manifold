import { useState } from "react";
import { Separate } from "./Separate.tsx";

export function Counter() {
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  return (
    <section className="plugin-example_fast-refresh" data-testid="refresh-counter">
      <h2 data-testid="refresh-heading">Packed entry</h2>
      <label>
        Draft
        <input
          data-testid="refresh-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <output data-testid="refresh-draft">{text}</output>
      <output data-testid="refresh-count">{count}</output>
      <button data-testid="refresh-increment" type="button" onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </section>
  );
}

export default {
  id: "example.fast-refresh",
  panels: { counter: Counter, separate: Separate },
};
