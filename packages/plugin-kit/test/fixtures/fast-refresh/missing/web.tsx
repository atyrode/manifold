export function Counter() {
  return (
    <section className="plugin-example_not-installed" data-testid="refresh-not-installed">
      A source file is not an installation.
    </section>
  );
}

export default { id: "example.not-installed", panels: { counter: Counter } };
