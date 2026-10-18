import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  label: string;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`UI error in ${this.props.label}`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-card" role="alert">
          <strong>The {this.props.label} panel failed to render.</strong>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
