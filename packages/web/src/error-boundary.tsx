import { Component, type ErrorInfo, type ReactNode } from "react";

interface PadErrorBoundaryProps {
  readonly children: ReactNode;
}

interface PadErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Contains canvas/runtime failures so a broken embed cannot strand the whole application.
 *
 * Deliberately NOT a toast. A toast is a message printed by a tree that is still
 * rendering; this fires when the tree has stopped rendering, which is precisely when
 * the toast layer below it no longer exists to print into. It is also not advisory —
 * the only way forward is a reload — so it takes the whole screen and says so.
 */
export class PadErrorBoundary extends Component<PadErrorBoundaryProps, PadErrorBoundaryState> {
  override state: PadErrorBoundaryState = { error: null };

  static getDerivedStateFromError(reason: unknown): PadErrorBoundaryState {
    return { error: reason instanceof Error ? reason : new Error("Unexpected view error") };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("manifold-web: pad render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <main className="gate-screen">
        <section className="gate-card" role="alert">
          <p className="eyebrow">view error</p>
          <h1>This view stopped unexpectedly</h1>
          <p>{this.state.error.message}</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}
