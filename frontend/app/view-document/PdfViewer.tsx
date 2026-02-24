'use client';

import { useCallback, useMemo, useState } from 'react';

interface Props {
  url: string;
  initialPage: number;
}

export default function PdfViewer({ url, initialPage }: Props) {
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage));

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
