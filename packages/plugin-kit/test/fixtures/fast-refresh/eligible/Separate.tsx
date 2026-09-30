import { useState } from "react";

export function Separate() {
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  return (
    <section className="plugin-example_fast-refresh" data-testid="refresh-separate">
      <h2 data-testid="refresh-separate-heading">Packed separate</h2>
      <label>
        Separate draft
        <input
          data-testid="refresh-separate-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <output data-testid="refresh-separate-draft">{text}</output>
      <output data-testid="refresh-separate-count">{count}</output>
      <button
        data-testid="refresh-separate-increment"
        type="button"
        onClick={() => setCount(count + 1)}
      >
        Increment separate
      </button>
    </section>
  );
}
