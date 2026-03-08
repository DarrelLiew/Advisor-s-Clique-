"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

// Common words that carry little discriminating signal — excluded from
// bag-of-words matching so noise doesn't inflate overlap scores.
const STOP_WORDS = new Set([
  "that", "this", "with", "from", "they", "been", "have", "were", "will",
  "your", "their", "which", "when", "also", "each", "more", "than", "then",
  "into", "over", "such", "upon", "under", "after", "before", "during",
  "about", "against", "between", "through", "shall", "would", "could",
  "should", "these", "those", "there", "where", "while", "other", "some",
  "make", "made", "only", "both", "must", "does", "done", "used", "been",
  "were", "paid", "pays", "paid", "plus", "less", "date", "time", "year",
  "note", "term", "plan", "base", "back",
]);

/** Words worth matching: long enough and not a stop word. */
function sigWords(words: string[]): string[] {
  return words.filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/** True if a word is a strong anchor (contains a digit, or is ≥ 7 chars). */
function isAnchorWord(w: string): boolean {
  return /\d/.test(w) || w.length >= 7;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalize(s: string): string {
  return s
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/[\u2013\u2014\u2012]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

  // Compute which text-layer items overlap with the chunk text.
  //
  // Phase 1 — LCS (sequence match): finds a run of ≥5 consecutive matching
  //   words between the page text layer and the chunk. Works perfectly for
  //   prose paragraphs where both parsers read text in the same order.
  //
  // Phase 2 — Bag-of-words fallback: used when Phase 1 finds no run (tables,
  //   multi-column layouts, scanned slides where pdfjs and the ingestion
  //   library read cells in different orders). Highlights every text item
  //   whose words overlap significantly with the chunk's significant words.
  const onGetTextSuccess = useCallback(
    (textContent: TextContent) => {
      if (!highlightText) {
        highlightMapRef.current = null;
        return;
      }

      const items = textContent.items.filter(
        (item): item is TextItem => "str" in item && !!(item as TextItem).str,
      );

      // Build per-item word list used by Phase 1.
      const pageWords: string[] = [];
      const wordToItem: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const words = normalize(items[i].str).split(/\s+/).filter(Boolean);
        for (const w of words) {
          pageWords.push(w);
          wordToItem.push(i);
        }
      }

      // Image-based / scanned pages have almost no text layer — skip.
      if (pageWords.length < 20) {
        highlightMapRef.current = null;
        return;
      }

      const chunkWords = normalize(highlightText).split(/\s+/).filter(Boolean);
      if (chunkWords.length < 3) {
        highlightMapRef.current = null;
        return;
      }

      // ── Phase 1: LCS word-sequence matching ──────────────────────────────
      const MIN_RUN = 5;
      let bestPageStart = -1;
      let bestRunLen = 0;

      for (let ps = 0; ps <= pageWords.length - MIN_RUN; ps++) {
        for (let cs = 0; cs < chunkWords.length; cs++) {
          if (pageWords[ps] !== chunkWords[cs]) continue;
          let run = 1;
          while (
            ps + run < pageWords.length &&
            cs + run < chunkWords.length &&
            pageWords[ps + run] === chunkWords[cs + run]
          ) {
            run++;
          }
          if (run > bestRunLen) {
            bestRunLen = run;
            bestPageStart = ps;
          }
        }
      }

      if (bestPageStart !== -1 && bestRunLen >= MIN_RUN) {
        const matched = new Set<number>();
        for (let wi = bestPageStart; wi <= Math.min(bestPageStart + bestRunLen - 1, pageWords.length - 1); wi++) {
          matched.add(wordToItem[wi]);
        }
        if (matched.size > 0) {
          highlightMapRef.current = matched;
          return;
        }
      }

      // ── Phase 2: Bag-of-words fallback (tables / reordered content) ──────
      // Build the set of significant words from the chunk.
      const chunkSig = new Set(sigWords(chunkWords));
      if (chunkSig.size < 3) {
        highlightMapRef.current = null;
        return;
      }

      // Guard: at least 45% of the chunk's significant words must appear
      // somewhere on this page, confirming this is actually the right page.
      const pageWordSet = new Set(pageWords);
      let pageOverlapCount = 0;
      for (const w of chunkSig) {
        if (pageWordSet.has(w)) pageOverlapCount++;
      }
      if (pageOverlapCount / chunkSig.size < 0.45) {
        highlightMapRef.current = null;
        return;
      }

      // Highlight each text item that has enough overlap with the chunk.
      // An item qualifies if:
      //   • it shares ≥ 2 significant words with the chunk, OR
      //   • it shares ≥ 1 anchor word (number / long term) with the chunk.
      const matched = new Set<number>();
      for (let i = 0; i < items.length; i++) {
        const iWords = sigWords(normalize(items[i].str).split(/\s+/).filter(Boolean));
        if (iWords.length === 0) continue;
        const hits = iWords.filter((w) => chunkSig.has(w));
        if (hits.length >= 2 || (hits.length === 1 && isAnchorWord(hits[0]))) {
          matched.add(i);
        }
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
