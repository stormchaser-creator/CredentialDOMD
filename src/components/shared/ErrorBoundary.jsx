import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("CredentialDOMD crashed:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        backgroundColor: "#f8f9fa",
        color: "#1a1a2e",
        textAlign: "center",
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, backgroundColor: "#6366f1",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginBottom: 20, fontSize: 24, fontWeight: 800, color: "#fff",
        }}>
          MD
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
          Something went wrong
        </h1>

        <p style={{ fontSize: 14, color: "#666", maxWidth: 360, lineHeight: 1.6, margin: "0 0 20px" }}>
          CredentialDOMD encountered an unexpected error. Your data is safe — it is stored locally
          and in the cloud. Try reloading the app.
        </p>

        {this.state.error && (
          <pre style={{
            fontSize: 11, color: "#dc3545", backgroundColor: "#fff",
            border: "1px solid #e9ecef", borderRadius: 8, padding: "10px 14px",
            maxWidth: 360, overflow: "auto", marginBottom: 20,
            textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {this.state.error.message || String(this.state.error)}
          </pre>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={this.handleReset} style={{
            padding: "10px 20px", borderRadius: 10, border: "1px solid #dee2e6",
            backgroundColor: "#fff", color: "#333", fontSize: 14, fontWeight: 600,
            cursor: "pointer",
          }}>
            Try Again
          </button>
          <button onClick={this.handleReload} style={{
            padding: "10px 20px", borderRadius: 10, border: "none",
            backgroundColor: "#6366f1", color: "#fff", fontSize: 14, fontWeight: 600,
            cursor: "pointer",
          }}>
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
