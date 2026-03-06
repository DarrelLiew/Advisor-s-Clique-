"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

interface Props {
  url: string;
  initialPage: number;
  highlightKey?: string;
  highlightText?: string;
}

export default function PdfViewer({
  url,
  initialPage,
  highlightKey,
  highlightText: highlightTextProp,
}: Props) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [highlightText, setHighlightText] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(800);
  const [jumpToPage, setJumpToPage] = useState<string>(String(initialPage));

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const highlightMapRef = useRef<Set<number> | null>(null);
  const scrolledRef = useRef(false);

  // Read highlight text from localStorage (web flow) or use URL param (Telegram flow)
  useEffect(() => {
    if (highlightKey) {
      const text = localStorage.getItem(highlightKey);
      if (text) {
        setHighlightText(text);
        localStorage.removeItem(highlightKey);
        return;
      }
    }
    if (highlightTextProp) {
      setHighlightText(highlightTextProp);
    }
  }, [highlightKey, highlightTextProp]);

  // Responsive width via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onDocumentLoadSuccess = useCallback(
    ({ numPages: n }: { numPages: number }) => {
      setNumPages(n);
    },
    [],
  );

  // Scroll to the initial page once document loads
  useEffect(() => {
    if (numPages === null || scrolledRef.current) return;
    // Small delay to allow pages to start rendering
    const timer = setTimeout(() => {
      const el = pageRefs.current.get(initialPage);
      if (el) {
        el.scrollIntoView({ behavior: "auto", block: "start" });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [numPages, initialPage]);

  const scrollToPage = useCallback((page: number) => {
    const el = pageRefs.current.get(page);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const handleJumpToPage = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const page = parseInt(jumpToPage, 10);
      if (page >= 1 && numPages && page <= numPages) {
        scrollToPage(page);
      }
    },
    [jumpToPage, numPages, scrollToPage],
  );

  // Compute which text-layer items overlap with the chunk text
  const onGetTextSuccess = useCallback(
    (textContent: TextContent) => {
      if (!highlightText) {
        highlightMapRef.current = null;
        return;
      }

      const items = textContent.items.filter(
        (item): item is TextItem => "str" in item && !!(item as TextItem).str,
      );

      // Build normalised concatenation and track per-item boundaries
      let concat = "";
      const boundaries: Array<{ idx: number; start: number; end: number }> = [];

      for (let i = 0; i < items.length; i++) {
        const norm = items[i].str.replace(/\s+/g, " ");
        if (!norm) continue;
        if (concat.length > 0) concat += " ";
        const start = concat.length;
        concat += norm;
        boundaries.push({ idx: i, start, end: concat.length });
      }

      const normConcat = concat.toLowerCase();
      const normChunk = normalize(highlightText);

      // Try progressively shorter/offset slices to find the best match.
      // Chunks often start with page headers — skip-header attempts avoid
      // highlighting boilerplate instead of actual content.
      // Prioritise longer matches and middle-of-chunk sections over prefixes.
      const len = normChunk.length;
      const attempts = [
        normChunk, // full chunk
        normChunk.slice(Math.floor(len * 0.15)), // skip header (~15%)
        normChunk.slice(Math.floor(len * 0.25)), // skip header (~25%)
        normChunk.slice(0, Math.floor(len * 0.8)), // first 80%
        normChunk.slice(Math.floor(len * 0.25), Math.floor(len * 0.85)), // middle 60%
        normChunk.slice(Math.floor(len * 0.15), Math.floor(len * 0.75)), // middle (different window)
        normChunk.slice(0, Math.floor(len * 0.6)), // first 60%
        normChunk.slice(Math.floor(len * 0.4)), // last 60%
        normChunk.slice(Math.floor(len * 0.5)), // last 50%
        // Short-prefix fallbacks (last resort)
        normChunk.slice(Math.floor(len * 0.15), Math.floor(len * 0.15) + 200), // 200 chars after header
        normChunk.slice(Math.floor(len * 0.25), Math.floor(len * 0.25) + 150), // 150 chars after header
        normChunk.slice(0, 200), // first 200 chars
        normChunk.slice(0, 100),
        normChunk.slice(0, 50),
      ].filter((s) => s.length >= 20);

      let matchStart = -1;
      let matchLen = 0;
      for (const attempt of attempts) {
        const pos = normConcat.indexOf(attempt);
        if (pos !== -1) {
          matchStart = pos;
          matchLen = attempt.length;
          break;
        }
      }

      if (matchStart === -1) {
        highlightMapRef.current = null;
        return;
      }

      const matchEnd = matchStart + matchLen;
      const matched = new Set<number>();
      for (const b of boundaries) {
        if (b.end > matchStart && b.start < matchEnd) matched.add(b.idx);
      }

      highlightMapRef.current = matched.size > 0 ? matched : null;
    },
    [highlightText],
  );

  // Highlight matching items inside the text layer
  const customTextRenderer = useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => {
      const map = highlightMapRef.current;
      if (map && map.has(itemIndex)) {
        return `<mark class="pdf-chunk-highlight">${escapeHtml(str)}</mark>`;
      }
      return str;
    },
    [],
  );

  // Scroll the first highlighted mark into view
  const onRenderTextLayerSuccess = useCallback(() => {
    if (scrolledRef.current) return;
    requestAnimationFrame(() => {
      const mark = containerRef.current?.querySelector(".pdf-chunk-highlight");
      if (mark) {
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        scrolledRef.current = true;
      }
    });
  }, []);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* CSS for highlight */}
      <style>{`
        .pdf-chunk-highlight {
          background-color: #fef08a !important;
          border-radius: 2px;
        }
        .pdf-page-wrapper {
          margin-bottom: 8px;
        }
      `}</style>

      {/* Navigation bar — jump to page */}
      <div
        style={{
          background: "#323639",
          color: "white",
          padding: "8px 16px",
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <form
          onSubmit={handleJumpToPage}
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <span style={{ fontSize: 14 }}>Page</span>
          <input
            type='number'
            min={1}
            max={numPages ?? undefined}
            value={jumpToPage}
            onChange={(e) => setJumpToPage(e.target.value)}
            style={{
              width: 60,
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid #555",
              background: "#444",
              color: "white",
              fontSize: 14,
              textAlign: "center",
            }}
          />
          <span style={{ fontSize: 14 }}>
            {numPages ? `of ${numPages}` : ""}
          </span>
          <button
            type='submit'
            style={{
              padding: "4px 12px",
              background: "#60a5fa",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Go
          </button>
        </form>
      </div>

      {/* PDF container — continuous scroll */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: "auto",
          background: "#525659",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "16px 0",
        }}
      >
        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={
            <div
              style={{ color: "#ccc", fontFamily: "sans-serif", padding: 32 }}
            >
              Loading PDF…
            </div>
          }
          error={
            <div
              style={{
                color: "#f87171",
                fontFamily: "sans-serif",
                padding: 32,
              }}
            >
              Failed to load PDF.
            </div>
          }
        >
          {numPages &&
            Array.from({ length: numPages }, (_, i) => {
              const pg = i + 1;
              const isHighlightPage = pg === initialPage && !!highlightText;
              return (
                <div
                  key={pg}
                  ref={(el) => {
                    if (el) pageRefs.current.set(pg, el);
                  }}
                  className='pdf-page-wrapper'
                >
                  <Page
                    pageNumber={pg}
                    width={Math.max(300, containerWidth - 32)}
                    renderTextLayer={true}
                    renderAnnotationLayer={true}
                    customTextRenderer={
                      isHighlightPage ? customTextRenderer : undefined
                    }
                    onGetTextSuccess={
                      isHighlightPage ? onGetTextSuccess : undefined
                    }
                    onRenderTextLayerSuccess={
                      isHighlightPage ? onRenderTextLayerSuccess : undefined
                    }
                    loading={
                      <div
                        style={{
                          color: "#ccc",
                          fontFamily: "sans-serif",
                          padding: 32,
                        }}
                      >
                        Loading page {pg}…
                      </div>
                    }
                  />
                </div>
              );
            })}
        </Document>
      </div>
    </div>
  );
}
