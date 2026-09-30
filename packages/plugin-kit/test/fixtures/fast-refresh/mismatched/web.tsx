export function Counter() {
  return (
    <section className="plugin-example_counter" data-testid="refresh-manifest-mismatch">
      An incompatible source must not replace an admitted plugin.
    </section>
  );
}

export default { id: "example.counter", panels: { counter: Counter } };
