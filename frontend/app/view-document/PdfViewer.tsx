'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Props {
  url: string;
  initialPage: number;
  highlightKey?: string;
}

export default function PdfViewer({ url, initialPage, highlightKey }: Props) {
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage));
  const [highlightText, setHighlightText] = useState<string | null>(null);
  const [highlightVisible, setHighlightVisible] = useState(true);

  // Read highlight text from localStorage on mount, then clean up
  useEffect(() => {
    if (!highlightKey) return;
    const text = localStorage.getItem(highlightKey);
    if (text) {
      setHighlightText(text);
      localStorage.removeItem(highlightKey);
    }
  }, [highlightKey]);

  const prev = useCallback(() => setPageNumber((p) => Math.max(1, p - 1)), []);
  const next = useCallback(() => setPageNumber((p) => p + 1), []);

  const viewerUrl = useMemo(() => {
    const safePage = Math.max(1, pageNumber);
    const hash = `#page=${safePage}&view=FitH`;
    return `${url}${hash}`;
  }, [url, pageNumber]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          background: '#323639',
          color: 'white',
          padding: '8px 16px',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <button
          onClick={prev}
          disabled={pageNumber <= 1}
          style={{
            padding: '4px 12px',
            background: pageNumber <= 1 ? '#555' : '#60a5fa',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: pageNumber <= 1 ? 'default' : 'pointer',
            fontSize: 14,
          }}
        >
          Prev
        </button>
        <span style={{ fontSize: 14 }}>Page {pageNumber}</span>
        <button
          onClick={next}
          style={{
            padding: '4px 12px',
            background: '#60a5fa',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          Next
        </button>
      </div>

      {/* Highlighted chunk callout */}
      {highlightText && highlightVisible && (
        <div
          style={{
            background: '#fef9c3',
            borderLeft: '4px solid #eab308',
            padding: '10px 14px',
            fontSize: 13,
            lineHeight: 1.5,
            color: '#713f12',
            flexShrink: 0,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>
              Referenced text from page {initialPage}
            </strong>
            <span style={{ whiteSpace: 'pre-wrap' }}>{highlightText}</span>
          </div>
          <button
            onClick={() => setHighlightVisible(false)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#a16207',
              fontSize: 18,
              lineHeight: 1,
              padding: '0 4px',
              flexShrink: 0,
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', background: '#525659' }}>
        <iframe
          key={viewerUrl}
          src={viewerUrl}
          title='Document Viewer'
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>
    </div>
  );
}
