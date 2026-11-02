import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last line of defence for the whole window. Without it, an exception thrown
 * while rendering any component unmounted the app and left a blank window with
 * no message and no way back but closing DiskFrame. Nothing here touches the
 * catalogue: reloading re-reads it from the main process.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] render failed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          background: 'var(--app-bg)',
          color: 'var(--app-fg)',
          textAlign: 'center'
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Something went wrong in this view</h1>
        <p style={{ color: 'var(--app-fg-dim)', maxWidth: 520, margin: 0 }}>
          Your files and catalogue are unaffected. Reloading the window usually recovers.
        </p>
        <code style={{ color: 'var(--app-fg-dim)', fontSize: 12, maxWidth: 640, wordBreak: 'break-word' }}>
          {error.message}
        </code>
        <button
          autoFocus
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            padding: '8px 18px',
            borderRadius: 8,
            border: '1px solid var(--df-glass-border)',
            background: 'var(--df-accent)',
            color: '#fff',
            cursor: 'pointer'
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}
