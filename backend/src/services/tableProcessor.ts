/**
 * Table-aware processing for the document embedding pipeline.
 *
 * Detects tables in extracted PDF text, enriches them via LLM into
 * natural-language + markdown composite chunks, and optionally uses
 * GPT-4o vision for pages with complex/merged tables.
 */

import OpenAI from 'openai';
import { createCanvas } from '@napi-rs/canvas';
import { ragConfig } from './ragConfig';

// ============================================================================
// Types
// ============================================================================

export interface DetectedTables {
  tables: string[];
  nonTableText: string;
}

export interface VisionExtractionResult {
  tables: string[];
  pageText: string;
}

// ============================================================================
// 1. Table Detection (text heuristic)
// ============================================================================

/**
 * Scans extracted page text and separates table-like regions from prose.
 * Broadened heuristics:
 *  - Lines with 2+ whitespace-separated columns
 *  - Lines with multiple percentage or currency values
 *  - Lines starting with a number followed by values (row data)
 */
export function detectTableRegions(pageText: string): DetectedTables {
  const lines = pageText.split('\n');
  const tables: string[] = [];
  let currentTable: string[] = [];
  const nonTableLines: string[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inTable) {
        // Blank line inside a table — end the region
        if (currentTable.length >= 2) {
          tables.push(currentTable.join('\n'));
        } else {
          nonTableLines.push(...currentTable);
        }
        currentTable = [];
        inTable = false;
      }
      nonTableLines.push(line);
      continue;
    }

    const columns = trimmed
      .split(/\s{2,}|\t/)
      .filter(Boolean);

    // Heuristic 1: 2+ whitespace-separated columns, each reasonably short
    const hasColumnPattern =
      columns.length >= 2 && columns.every((c) => c.length < 50);

    // Heuristic 2: line contains 2+ percentage values (e.g. "100%  75%  80%")
    const percentMatches = trimmed.match(/\d+\.?\d*\s*%/g);
    const hasMultiplePercents = percentMatches !== null && percentMatches.length >= 2;

    // Heuristic 3: line contains 2+ currency/numeric values with common separators
    const numericCols = trimmed.match(/(?:\$[\d,.]+|\d{1,3}(?:,\d{3})+(?:\.\d+)?)/g);
    const hasMultipleNumerics = numericCols !== null && numericCols.length >= 2;

    // Heuristic 4: line starts with a number/year and is followed by values (table row)
    const isNumberedRow = /^\d{1,4}(?:\s+onwards)?\s{2,}/.test(trimmed);

    const isTableLine = hasColumnPattern || hasMultiplePercents || hasMultipleNumerics || isNumberedRow;

    if (isTableLine) {
      if (!inTable) inTable = true;
      currentTable.push(line);
    } else {
      if (inTable && currentTable.length >= 2) {
        tables.push(currentTable.join('\n'));
        currentTable = [];
        inTable = false;
      } else if (inTable) {
        // Single-line match — probably not a table
        nonTableLines.push(...currentTable);
        currentTable = [];
        inTable = false;
      }
      nonTableLines.push(line);
    }
  }

  if (currentTable.length >= 2) tables.push(currentTable.join('\n'));
  else nonTableLines.push(...currentTable);

  return { tables, nonTableText: nonTableLines.join('\n') };
}

// ============================================================================
// 2. Complex-table heuristic (decides if vision is needed)
// ============================================================================

/**
 * Returns true when the page likely contains merged rows/columns that
 * text-based extraction cannot handle.  Used by the hybrid approach
 * to decide whether to invoke GPT-4o vision.
 */
export function hasComplexTableIndicators(
  textTables: string[],
  pageText: string,
): boolean {
  // Check 1: any detected table has lines with far fewer columns than its header
  const hasMergeIndicators = textTables.some((t) => {
    const lines = t.split('\n');
    const columnCounts = lines.map(
      (l) =>
        l
          .trim()
          .split(/\s{2,}|\t/)
          .filter(Boolean).length,
    );
    const headerCols = columnCounts[0] || 0;
    return columnCounts.some((c) => c > 0 && c < headerCols - 1);
  });

  // Check 2: disconnected header line before table content
  const hasDisconnectedHeader = /\n[A-Z][a-z ]+\n/.test(
    pageText.slice(0, 200),
  );

  return hasMergeIndicators || hasDisconnectedHeader;
}

// ============================================================================
// 3. LLM table enrichment (gpt-4o-mini)
// ============================================================================

/**
 * Calls gpt-4o-mini to convert a raw text-extracted table into a composite
 * chunk: natural-language summary + clean markdown table.
 * Falls back to the raw table on any error.
 */
export async function enrichTable(
  openai: OpenAI,
  rawTable: string,
  pageNumber: number,
  surroundingContext: string,
): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content:
            'You convert tables from financial documents into clear, complete natural language. Never omit data.',
        },
        {
          role: 'user',
          content: `Table extracted from page ${pageNumber} of a financial advisory document.

Surrounding text for context:
${surroundingContext.slice(0, 500)}

Raw table:
${rawTable}

Output format:
1. First line: brief description of what this table shows
2. Then: each row as a complete sentence including all column headers as context
3. Finally: the table in clean markdown format

Include ALL values. Do not summarize or skip rows.`,
        },
      ],
    });

    return response.choices[0].message.content || rawTable;
  } catch (err: any) {
    console.warn(
      `[TABLE] enrichTable failed for page ${pageNumber}: ${err.message}`,
    );
    return rawTable;
  }
}

// ============================================================================
// 4. Large-table splitting
// ============================================================================

/**
 * Splits an enriched table chunk that exceeds maxChars.
 * Each sub-chunk repeats the header rows for context continuity.
 */
export function splitLargeTable(
  enrichedTable: string,
  maxChars: number = ragConfig.chunkSize,
): string[] {
  if (enrichedTable.length <= maxChars) return [enrichedTable];

  const lines = enrichedTable.split('\n');

  // Find the markdown table inside the enriched text (starts with | header |)
  let tableStartIdx = -1;
  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|') && tableStartIdx === -1) {
      tableStartIdx = i;
    }
    if (
      tableStartIdx >= 0 &&
      separatorIdx === -1 &&
      /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i])
    ) {
      separatorIdx = i;
    }
  }

  // If no markdown table found, do a simple character-based split
  if (tableStartIdx === -1 || separatorIdx === -1) {
    const chunks: string[] = [];
    for (let i = 0; i < enrichedTable.length; i += maxChars) {
      chunks.push(enrichedTable.slice(i, i + maxChars));
    }
    return chunks;
  }

  // NL summary = everything before the markdown table
  const nlSummary = lines.slice(0, tableStartIdx).join('\n').trim();
  const headerLines = lines.slice(tableStartIdx, separatorIdx + 1);
  const dataLines = lines.slice(separatorIdx + 1).filter((l) => l.trim());

  // Split data lines into groups that fit within maxChars
  const headerText = [nlSummary, ...headerLines].join('\n');
  const headerLen = headerText.length + 2; // +2 for \n separators
  const availableChars = maxChars - headerLen;

  const chunks: string[] = [];
  let currentDataLines: string[] = [];
  let currentLen = 0;

  for (const line of dataLines) {
    if (currentLen + line.length + 1 > availableChars && currentDataLines.length > 0) {
      const partLabel = `[Part ${chunks.length + 1}]`;
      chunks.push(
        [partLabel, nlSummary, ...headerLines, ...currentDataLines].join('\n'),
      );
      currentDataLines = [];
      currentLen = 0;
    }
    currentDataLines.push(line);
    currentLen += line.length + 1;
  }

  if (currentDataLines.length > 0) {
    const partLabel = chunks.length > 0 ? `[Part ${chunks.length + 1}]` : '';
    const parts = partLabel
      ? [partLabel, nlSummary, ...headerLines, ...currentDataLines]
      : [nlSummary, ...headerLines, ...currentDataLines];
    chunks.push(parts.join('\n'));
  }

  // If only one chunk resulted, return the original
  if (chunks.length <= 1) return [enrichedTable];

  // Update part labels with total count
  const total = chunks.length;
  return chunks.map((chunk, i) =>
    chunk.replace(/^\[Part \d+\]/, `[Part ${i + 1} of ${total}]`),
  );
}

// ============================================================================
// 5. Vision-based extraction (GPT-4o)
// ============================================================================

/**
 * Converts a PDF buffer into an array of base64-encoded PNG images,
 * one per page.  Uses pdfjs-dist for PDF parsing + @napi-rs/canvas
 * for rendering to PNG.
 *
 * Returns a sparse array — index 0 = page 1.  Pages that fail render
 * are null so the caller can fall back to text extraction.
 */
export async function pdfToImages(
  buffer: Buffer,
): Promise<Array<string | null>> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
    .promise;
  const numPages = doc.numPages;
  const images: Array<string | null> = new Array(numPages).fill(null);

  for (let i = 1; i <= numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 }); // 2x for readability
      const width = Math.floor(viewport.width);
      const height = Math.floor(viewport.height);

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Fill white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      await page.render({
        // @ts-ignore — pdfjs typing expects browser CanvasRenderingContext2D
        canvasContext: ctx,
        viewport,
      }).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      images[i - 1] = pngBuffer.toString('base64');
    } catch (err: any) {
      console.warn(
        `[TABLE] pdfToImages: failed to render page ${i}: ${err.message}`,
      );
      images[i - 1] = null;
    }
  }

  return images;
}

/**
 * Sends a page image to GPT-4o vision to extract tables with merged cells
 * correctly resolved.  Returns parsed tables (markdown) and body text.
 */
export async function extractTablesViaVision(
  openai: OpenAI,
  pageImageBase64: string,
  pageNumber: number,
): Promise<VisionExtractionResult> {
  const VISION_TIMEOUT_MS = 60_000; // 60s timeout per page

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    console.log(`[TABLE] page ${pageNumber}: starting GPT-4o vision call...`);
    const response = await openai.chat.completions.create(
      {
        model: 'gpt-4o',
        temperature: 0,
        max_tokens: 4000,
        messages: [
          {
            role: 'system',
            content: `You extract content from financial document pages. Separate tables from body text.

For tables:
- Output each table as a markdown table with correct headers
- FLATTEN merged headers: if "Annualized Returns" spans over "1-Year, 3-Year, 5-Year", output columns as "Annualized Returns - 1-Year", "Annualized Returns - 3-Year", etc.
- EXPAND merged row categories: if "Equity" groups ABC and DEF funds, prepend the category to each row: "Equity - ABC Growth"
- Preserve ALL cell values exactly as shown — do not round, abbreviate, or omit
- Mark each table with: <!-- TABLE_START --> and <!-- TABLE_END -->

For body text:
- Output all non-table text between tables, preserving reading order
- Mark as: <!-- TEXT_START --> and <!-- TEXT_END -->`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Extract all content from page ${pageNumber}. Separate tables from body text.`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${pageImageBase64}`,
                },
              },
            ],
          },
        ],
      },
      { signal: controller.signal },
    );

    const content = response.choices[0].message.content || '';
    console.log(`[TABLE] page ${pageNumber}: vision call complete (${content.length} chars)`);

    const tables: string[] = [];
    const textParts: string[] = [];

    const tableRegex =
      /<!-- TABLE_START -->\s*([\s\S]*?)\s*<!-- TABLE_END -->/g;
    const textRegex =
      /<!-- TEXT_START -->\s*([\s\S]*?)\s*<!-- TEXT_END -->/g;

    let match;
    while ((match = tableRegex.exec(content)) !== null) {
      tables.push(match[1].trim());
    }
    while ((match = textRegex.exec(content)) !== null) {
      textParts.push(match[1].trim());
    }

    // Fallback: if no markers found, treat entire response as text
    if (tables.length === 0 && textParts.length === 0) {
      textParts.push(content);
    }

    return { tables, pageText: textParts.join('\n\n') };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// 6. Orchestrator: process a single page (hybrid approach)
// ============================================================================

export interface TableChunk {
  pageNumber: number;
  text: string;
}

/**
 * Processes a single page with the hybrid approach:
 * - Detect table regions via broadened text heuristics
 * - If page image is available → use GPT-4o vision for accurate extraction
 * - Otherwise → enrich tables via gpt-4o-mini (text-only fallback)
 *
 * Returns: { nonTableText, tableChunks[] }
 */
export async function processPageTables(
  openai: OpenAI,
  page: { page_number: number; text: string },
  pageImageBase64: string | null,
): Promise<{ nonTableText: string; tableChunks: TableChunk[] }> {
  const { tables: textTables, nonTableText } = detectTableRegions(page.text);

  if (textTables.length === 0) {
    return { nonTableText: page.text, tableChunks: [] };
  }

  console.log(
    `[TABLE] page ${page.page_number}: detected ${textTables.length} table region(s)`,
  );

  const tableChunks: TableChunk[] = [];
  const useVision = pageImageBase64 !== null;

  if (useVision) {
    // Vision path: send page image to GPT-4o for accurate table extraction
    console.log(
      `[TABLE] page ${page.page_number}: table detected, using vision extraction`,
    );
    try {
      const { tables: visionTables, pageText: visionText } =
        await extractTablesViaVision(openai, pageImageBase64!, page.page_number);

      console.log(
        `[TABLE] page ${page.page_number}: vision extracted ${visionTables.length} table(s), ${visionText.length} chars text`,
      );

      for (const table of visionTables) {
        // Vision tables are already clean markdown — skip enrichment, just split if needed
        const parts = splitLargeTable(table);
        for (const part of parts) {
          tableChunks.push({ pageNumber: page.page_number, text: part });
        }
      }

      // Return vision-extracted body text instead of heuristic-stripped text
      return { nonTableText: visionText || nonTableText, tableChunks };
    } catch (err: any) {
      console.warn(
        `[TABLE] page ${page.page_number}: vision extraction failed, falling back to text: ${err.message}`,
      );
      // Fall through to text-based enrichment below
    }
  }

  // Text-based path: enrich each detected table via gpt-4o-mini
  for (const table of textTables) {
    const enriched = await enrichTable(
      openai,
      table,
      page.page_number,
      nonTableText.slice(0, 500),
    );
    const parts = splitLargeTable(enriched);
    for (const part of parts) {
      tableChunks.push({ pageNumber: page.page_number, text: part });
    }
  }

  return { nonTableText, tableChunks };
}
