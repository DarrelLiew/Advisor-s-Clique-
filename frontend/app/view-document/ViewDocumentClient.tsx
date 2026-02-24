'use client';

import dynamic from 'next/dynamic';
import { Component, ReactNode } from 'react';

// Error boundary catches pdfjs / react-pdf runtime crashes.
// Full error details are logged to console.error for debugging.
// Users see a safe fallback message — no stack traces in the DOM.
class PdfErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  componentDidCatch(error: Error) {
    console.error('[PdfErrorBoundary] caught:', error);
    this.setState({ error });
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            flex: 1,
            padding: 32,
            fontFamily: 'sans-serif',
            background: '#f8f9fa',
            color: '#495057',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
            Unable to display this document.
          </p>
          <p style={{ fontSize: 14, color: '#6c757d', margin: 0 }}>
            Please try refreshing the page or opening the document in a new tab.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const PdfViewer = dynamic(() => import('./PdfViewer'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        background: '#525659',
        color: '#ccc',
        fontFamily: 'sans-serif',
      }}
    >
      Loading PDF viewer…
    </div>
  ),
});

interface Props {
  url: string;
  page: number;
}

export default function ViewDocumentClient({ url, page }: Props) {
  return (
    <PdfErrorBoundary>
      <PdfViewer url={url} initialPage={page} />
    </PdfErrorBoundary>
  );
}
