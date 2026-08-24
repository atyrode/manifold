import { Component, type ErrorInfo, type ReactNode } from "react";

interface PadErrorBoundaryProps {
  readonly children: ReactNode;
}

interface PadErrorBoundaryState {
  readonly error: Error | null;
}

/** Contains canvas/runtime failures so a broken embed cannot strand the whole application. */
export class PadErrorBoundary extends Component<PadErrorBoundaryProps, PadErrorBoundaryState> {
  override state: PadErrorBoundaryState = { error: null };

  static getDerivedStateFromError(reason: unknown): PadErrorBoundaryState {
    return { error: reason instanceof Error ? reason : new Error("Unexpected pad error") };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("manifold-web: pad render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <main className="gate-screen">
        <section className="gate-card" role="alert">
          <p className="eyebrow">pad error</p>
          <h1>The canvas stopped unexpectedly</h1>
          <p>{this.state.error.message}</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}
