# Table Embedding for RAG — Preserving Structure & Context

## The Problem

Our current document processor ([documentProcessor.ts](backend/src/services/documentProcessor.ts)) uses `pdf-parse` which extracts raw text line-by-line based on Y-position changes. When it encounters a table, it flattens the grid into a stream of text — destroying row/column relationships, merging cell values from different columns into the same line, and losing header associations entirely.

**What happens today:**

```
| Fund Name | 1-Year | 3-Year | 5-Year |
| ABC Growth | 12.5%  | 8.3%   | 10.1%  |
| XYZ Income | 5.2%   | 4.8%   | 6.0%   |
```

Gets extracted as:

```
Fund Name 1-Year 3-Year 5-Year
ABC Growth 12.5% 8.3% 10.1%
XYZ Income 5.2% 4.8% 6.0%
```

Then chunked naively — potentially splitting headers from data rows, or mixing table content with surrounding prose. When a user asks "What is the 3-year return of ABC Growth?", the embedding of `"ABC Growth 12.5% 8.3% 10.1%"` has weak semantic signal for matching "3-year return" because the column header is gone.

---

## Merged Rows & Columns — The Hard Problem

Standard text extraction (`pdf-parse`) completely loses merge information. A table like:

```
┌─────────────┬──────────────────────────────┐
│             │      Annualized Returns      │  ← merged across 3 sub-columns
│  Fund Name  ├──────────┬─────────┬─────────┤
│             │  1-Year  │ 3-Year  │ 5-Year  │
├─────────────┼──────────┼─────────┼─────────┤
│ Equity      │          │         │         │  ← merged row spanning all columns
├─────────────┼──────────┼─────────┼─────────┤
│ ABC Growth  │  12.5%   │  8.3%   │  10.1%  │
│ DEF Value   │   9.1%   │  7.2%   │   8.5%  │
├─────────────┼──────────┼─────────┼─────────┤
│ Fixed Income│          │         │         │  ← another merged category row
├─────────────┼──────────┼─────────┼─────────┤
│ XYZ Bond    │   5.2%   │  4.8%   │   6.0%  │
└─────────────┴──────────┴─────────┴─────────┘
```

Gets extracted by `pdf-parse` as:

```
Annualized Returns
Fund Name 1-Year 3-Year 5-Year
Equity
ABC Growth 12.5% 8.3% 10.1%
DEF Value 9.1% 7.2% 8.5%
Fixed Income
XYZ Bond 5.2% 4.8% 6.0%
```

The multi-level header "Annualized Returns" is disconnected. The category rows "Equity" and "Fixed Income" lose their grouping role. Heuristic detection can't reconstruct this.

### Why Text-Based Approaches Fail for Merges

| Scenario                        | What `pdf-parse` sees                   | What's lost                      |
| ------------------------------- | --------------------------------------- | -------------------------------- |
| Merged column header            | Separate text line above                | Parent-child header relationship |
| Merged row category             | Single-column text line                 | Grouping of rows below it        |
| Spanning cell (notes/footnotes) | Text fragment at wrong position         | Cell boundary information        |
| Multi-line cell content         | Multiple lines mixed with other columns | Which lines belong to which cell |

**No amount of regex or whitespace heuristics can reliably recover merge structure from flattened text.** The merge coordinates exist in the PDF's internal structure but are discarded during text extraction.

### Solution: Vision-Based Extraction (Recommended for Merged Tables)

Send each PDF page as an image to GPT-4o, which can **see** the visual table layout — including merged cells, spanning headers, and category rows — and output clean, correctly structured markdown.

**Why this works:** GPT-4o processes the rendered page the same way a human reads it. It sees grid lines, alignment, and visual grouping that text extraction destroys.

```typescript
import { readFileSync } from "fs";
import pdf2img from "pdf-img-convert"; // or similar: pdf2pic, pdf-poppler

/**
 * Convert a PDF buffer to an array of base64-encoded page images
 */
async function pdfToImages(buffer: Buffer): Promise<string[]> {
  // pdf-img-convert returns array of Uint8Array per page
  const pages = await pdf2img.convert(buffer, {
    width: 1600, // Good resolution for table reading
    height: 2200,
    page_numbers: undefined, // All pages
  });
  return pages.map((page: Uint8Array) => Buffer.from(page).toString("base64"));
}

/**
 * Extract tables from a PDF page image using GPT-4o vision.
 * Returns: { tables: markdown string[], pageText: string }
 */
async function extractTablesViaVision(
  pageImageBase64: string,
  pageNumber: number,
): Promise<{ tables: string[]; pageText: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 4000,
    messages: [
      {
        role: "system",
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
        role: "user",
        content: [
          {
            type: "text",
            text: `Extract all content from page ${pageNumber}. Separate tables from body text.`,
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pageImageBase64}` },
          },
        ],
      },
    ],
  });

  const content = response.choices[0].message.content || "";

  // Parse out tables and text from the marked-up response
  const tables: string[] = [];
  const textParts: string[] = [];

  const tableRegex = /<!-- TABLE_START -->\s*([\s\S]*?)\s*<!-- TABLE_END -->/g;
  const textRegex = /<!-- TEXT_START -->\s*([\s\S]*?)\s*<!-- TEXT_END -->/g;

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

  return { tables, pageText: textParts.join("\n\n") };
}
```

**Example output for the merged table above:**

```markdown
| Category - Fund Name    | Annualized Returns - 1-Year | Annualized Returns - 3-Year | Annualized Returns - 5-Year |
| ----------------------- | --------------------------- | --------------------------- | --------------------------- |
| Equity - ABC Growth     | 12.5%                       | 8.3%                        | 10.1%                       |
| Equity - DEF Value      | 9.1%                        | 7.2%                        | 8.5%                        |
| Fixed Income - XYZ Bond | 5.2%                        | 4.8%                        | 6.0%                        |
```

Every merge is resolved: the multi-level header is flattened into composite column names, and the category rows are prepended to each data row. This embeds and retrieves accurately.

### Hybrid Approach: Text-First, Vision Fallback

To keep costs down, use vision only for pages that likely contain complex tables:

```typescript
async function processPageSmart(
  page: { page_number: number; text: string },
  pageImageBase64: string | null,
  documentId: string,
) {
  const { tables: textTables, nonTableText } = detectTableRegions(page.text);

  // Heuristic: does this page likely have merged/complex tables?
  const hasMergeIndicators =
    textTables.some((t) => {
      const lines = t.split("\n");
      // Merged row: a line with fewer columns than the header
      const columnCounts = lines.map(
        (l) =>
          l
            .trim()
            .split(/\s{2,}|\t/)
            .filter(Boolean).length,
      );
      const headerCols = columnCounts[0] || 0;
      return columnCounts.some((c) => c > 0 && c < headerCols - 1);
    }) ||
    // Disconnected header line (appears before table but not part of it)
    /\n[A-Z][a-z ]+\n/.test(page.text.slice(0, 200));

  if (hasMergeIndicators && pageImageBase64) {
    // Complex table detected → use vision for this page
    console.log(
      `Page ${page.page_number}: complex table detected, using vision extraction`,
    );
    const { tables, pageText } = await extractTablesViaVision(
      pageImageBase64,
      page.page_number,
    );

    // Chunk body text normally
    // ... chunkPage({ ...page, text: pageText }, ...)

    // Enrich each vision-extracted table (already clean markdown)
    for (const table of tables) {
      const enriched = await enrichTable(
        table,
        page.page_number,
        pageText.slice(0, 500),
      );
      // ... create atomic table chunk
    }
  } else {
    // Simple tables or no tables → use text heuristics (cheaper)
    // ... existing detectTableRegions + enrichTable flow
  }
}
```

### Cost Comparison

| Method                                  | Per Page    | Per Table | Handles Merges      | Speed          |
| --------------------------------------- | ----------- | --------- | ------------------- | -------------- |
| Text heuristic + gpt-4o-mini enrichment | ~$0.0005    | ~$0.001   | No                  | Fast (~1s)     |
| GPT-4o vision extraction                | ~$0.01      | included  | Yes                 | Slower (~3-5s) |
| Hybrid (vision only for complex pages)  | ~$0.003 avg | included  | Yes                 | Mixed          |
| pdfplumber (Python microservice)        | Free        | Free      | Yes (simple merges) | Fast           |

For a 50-page document where ~10 pages have tables and ~3 have merged tables:

- **Text-only:** ~$0.015 total
- **Hybrid:** ~$0.04 total (vision for 3 complex pages + text for rest)
- **Full vision:** ~$0.50 total (every page)

The hybrid approach is the sweet spot — only 2-3x more expensive than text-only, but handles every table correctly.

---

## Core Principles

1. **Tables are atomic units** — never split a table across chunks
2. **Headers must travel with data** — every row needs its column context
3. **Serialize for semantics, not display** — embeddings work on meaning, not layout
4. **Enrich with natural language** — an LLM summary of the table dramatically improves retrieval
5. **Preserve source metadata** — page number, table index, surrounding section title

---

## Recommended Pipeline

### Step 1: Structure-Aware PDF Extraction

Replace raw text extraction with a layout-aware parser that identifies tables as distinct elements.

**Option A: `pdfplumber` (Python, most reliable for tables)**

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()  # Returns list of 2D arrays
        text = page.extract_text()       # Returns non-table text
```

**Option B: `Unstructured.io` (Python, full document parsing)**

```python
from unstructured.partition.pdf import partition_pdf

elements = partition_pdf(
    "document.pdf",
    strategy="hi_res",           # Layout-aware extraction
    chunking_strategy="by_title" # Preserves section boundaries
)

# Elements are typed: NarrativeText, Table, Image, Title, etc.
tables = [el for el in elements if el.category == "Table"]
```

**Option C: LLM text-based extraction (works with our current stack)**

Since we already use OpenAI gpt-4o-mini, we can use `pdf-parse` for text extraction and then have the LLM identify and reformat tables detected on each page. This avoids adding Python dependencies. **Limitation:** cannot recover merged rows/columns (see section above).

**Option D: GPT-4o Vision extraction (recommended for merged tables)**

Convert each PDF page to an image and send to GPT-4o, which visually reads the table layout — including merged cells, spanning headers, and category rows. See the full implementation in the "Vision-Based Extraction" section above. Use the hybrid approach (text-first, vision fallback) to keep costs low while handling complex tables correctly.

### Step 2: Table Serialization

Convert extracted tables into formats that preserve structure for embedding.

**Markdown format (recommended for our stack):**

```markdown
| Fund Name  | 1-Year | 3-Year | 5-Year |
| ---------- | ------ | ------ | ------ |
| ABC Growth | 12.5%  | 8.3%   | 10.1%  |
| XYZ Income | 5.2%   | 4.8%   | 6.0%   |
```

Research ("Table Meets LLM" study) shows that preserving table schemas — column names, hierarchical headers — in markdown/HTML format leads to better cell value extraction by LLMs.

**Row-by-row natural language (best for embedding quality):**

```
ABC Growth Fund: 1-Year return is 12.5%, 3-Year return is 8.3%, 5-Year return is 10.1%.
XYZ Income Fund: 1-Year return is 5.2%, 3-Year return is 4.8%, 5-Year return is 6.0%.
```

This format has the strongest semantic signal because each fact is self-contained — the embedding for "ABC Growth 3-Year return 8.3%" directly matches the query "What is ABC Growth's 3-year return?"

### Step 3: LLM Contextual Enrichment

Generate a natural-language summary of the table that captures its purpose and key insights. This summary becomes the primary embedding target.

**Prompt template:**

```
Given the following table extracted from a financial advisory document (page {page_number}, section: "{section_title}"):

{markdown_table}

Provide:
1. A brief description of what this table contains (1-2 sentences)
2. The table reformatted as natural language, with each row as a complete sentence that includes all column headers as context

Do NOT omit any data. Every cell value must appear in your output.
```

**Example output:**

```
This table compares the annualized returns of two investment funds across 1-year, 3-year, and 5-year periods.

- ABC Growth Fund has a 1-year return of 12.5%, a 3-year annualized return of 8.3%, and a 5-year annualized return of 10.1%.
- XYZ Income Fund has a 1-year return of 5.2%, a 3-year annualized return of 4.8%, and a 5-year annualized return of 6.0%.
```

### Step 4: Composite Chunk Assembly

Create a single chunk that combines the summary + the original markdown table:

```
[Table: Fund Performance Comparison — Page 14]

This table compares the annualized returns of two investment funds across 1-year, 3-year, and 5-year periods.

- ABC Growth Fund has a 1-year return of 12.5%, a 3-year annualized return of 8.3%, and a 5-year annualized return of 10.1%.
- XYZ Income Fund has a 1-year return of 5.2%, a 3-year annualized return of 4.8%, and a 5-year annualized return of 6.0%.

Source table:
| Fund Name  | 1-Year | 3-Year | 5-Year |
|------------|--------|--------|--------|
| ABC Growth | 12.5%  | 8.3%   | 10.1%  |
| XYZ Income | 5.2%   | 4.8%   | 6.0%   |
```

This gives the best of both worlds:

- The NL summary provides strong semantic signal for vector search
- The original markdown table gives the LLM precise values for generation

### Step 5: Embed & Store

Embed the composite chunk using `text-embedding-3-small` (same as current pipeline). Store with metadata:

```typescript
{
  document_id: "...",
  page_number: 14,
  chunk_index: 42,
  content: compositeChunkText,       // NL summary + markdown table
  embedding: [...],                  // 1536-dim vector
  // metadata (if column added):
  // chunk_type: "table",
  // table_index: 0,
  // section_title: "Fund Performance"
}
```

---

## Implementation for Our Stack (TypeScript + OpenAI)

Since we use `pdf-parse` (Node.js) and don't want Python dependencies, the practical approach is:

### A. Detect Tables in Extracted Text

After `pdf-parse` extracts page text, use heuristics to detect table-like regions:

```typescript
function detectTableRegions(pageText: string): {
  tables: string[];
  nonTableText: string;
} {
  const lines = pageText.split("\n");
  const tables: string[] = [];
  let currentTable: string[] = [];
  let nonTableLines: string[] = [];
  let inTable = false;

  for (const line of lines) {
    // Heuristic: lines with 3+ whitespace-separated columns of similar width
    // or lines with pipe characters, or lines with consistent tab/space alignment
    const columns = line
      .trim()
      .split(/\s{2,}|\t/)
      .filter(Boolean);
    const hasTablePattern =
      columns.length >= 3 && columns.every((c) => c.length < 40);

    if (hasTablePattern) {
      if (!inTable) inTable = true;
      currentTable.push(line);
    } else {
      if (inTable && currentTable.length >= 2) {
        tables.push(currentTable.join("\n"));
        currentTable = [];
        inTable = false;
      } else if (inTable) {
        // Single line match — probably not a table
        nonTableLines.push(...currentTable);
        currentTable = [];
        inTable = false;
      }
      nonTableLines.push(line);
    }
  }

  if (currentTable.length >= 2) tables.push(currentTable.join("\n"));
  else nonTableLines.push(...currentTable);

  return { tables, nonTableText: nonTableLines.join("\n") };
}
```

### B. Reformat Tables via LLM

```typescript
async function enrichTable(
  rawTable: string,
  pageNumber: number,
  surroundingContext: string,
): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You convert tables from financial documents into clear, complete natural language. Never omit data.",
      },
      {
        role: "user",
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
}
```

### C. Modified Chunking Flow

```typescript
// In processDocument(), after extractTextFromPDF():
for (const page of pages) {
  const { tables, nonTableText } = detectTableRegions(page.text);

  // Chunk non-table text normally (existing chunkPage logic)
  for (const chunk of chunkPage(
    { ...page, text: nonTableText },
    documentId,
    chunkIndex,
  )) {
    // ... existing batch logic
  }

  // Process each table as an atomic chunk
  for (const table of tables) {
    const enriched = await enrichTable(
      table,
      page.page_number,
      nonTableText.slice(0, 500),
    );
    const tableChunk: DocumentChunk = {
      document_id: documentId,
      page_number: page.page_number,
      chunk_index: chunkIndex++,
      text: enriched, // NL summary + markdown = strong embedding
    };
    currentBatch.push(tableChunk);
  }
}
```

---

## Large Tables (>800 tokens)

For tables that exceed the chunk size limit:

1. **Split by logical groups** — if the table has clear section breaks (e.g., different fund categories), split there
2. **Repeat headers** — every sub-chunk must include the full column headers
3. **Add navigation metadata** — "Part 1 of 3: Equity Funds" so the LLM knows there's more data

```typescript
function splitLargeTable(
  markdownTable: string,
  maxRows: number = 15,
): string[] {
  const lines = markdownTable.split("\n");
  const headerLines = lines.slice(0, 2); // Header + separator
  const dataLines = lines.slice(2);

  const chunks: string[] = [];
  for (let i = 0; i < dataLines.length; i += maxRows) {
    const slice = dataLines.slice(i, i + maxRows);
    const partLabel = `[Part ${Math.floor(i / maxRows) + 1} of ${Math.ceil(dataLines.length / maxRows)}]`;
    chunks.push([partLabel, ...headerLines, ...slice].join("\n"));
  }
  return chunks;
}
```

---

## Multi-Vector Retrieval (Advanced)

For maximum accuracy, store two vectors per table:

1. **Summary embedding** — the NL description (great for "what table has fund returns?")
2. **Content embedding** — the markdown table (great for "what is ABC's 3-year return?")

Both point to the same chunk content. At retrieval time, either vector can match, and the full composite chunk is returned to the LLM.

This requires adding a `chunk_type` or `vector_type` column to `document_chunks`, or using a separate table for summary vectors.

---

## Cost Considerations

- **LLM enrichment cost:** ~$0.001 per table (gpt-4o-mini, ~500 input + 300 output tokens)
- **Extra embedding cost:** Negligible (~$0.00001 per table chunk)
- **Processing time:** +1-2 seconds per table for the LLM call
- **For a typical 50-page financial document with 10-15 tables:** ~$0.015 extra total

This is well worth the accuracy improvement for financial advisory documents where tables contain the most queried data (fund comparisons, fee schedules, performance metrics, compliance checklists).

---

## Key Takeaways

| Technique                                | Retrieval Boost | Implementation Effort | Handles Merges | Our Priority   |
| ---------------------------------------- | --------------- | --------------------- | -------------- | -------------- |
| Detect tables as atomic units            | High            | Low                   | No             | Do first       |
| Markdown serialization                   | Medium          | Low                   | No             | Do first       |
| NL summary via LLM (gpt-4o-mini)        | Very High       | Medium                | No             | Do second      |
| Composite chunks (NL + markdown)         | Very High       | Medium                | No             | Do second      |
| GPT-4o vision for complex pages (hybrid) | Very High       | Medium                | Yes            | Do second      |
| Multi-vector retrieval                   | Highest         | High                  | N/A            | Future         |
| Structure-aware parser (Unstructured.io) | High            | High (Python dep)     | Yes            | Evaluate later |

---

## Sources

- [Mastering RAG: Precision Techniques for Table-Heavy Documents (KX)](https://kx.com/blog/mastering-rag-precision-techniques-for-table-heavy-documents/)
- [From PDF Tables to Insights: Alternative Approach for Parsing PDFs in RAG (Elasticsearch)](https://www.elastic.co/search-labs/blog/alternative-approach-for-parsing-pdfs-in-rag)
- [How to Handle Tables During Chunking (Rohan Paul)](https://www.rohan-paul.com/p/how-to-handle-tables-during-chunking)
- [Mastering RAG: Precision from Table-Heavy PDFs (Towards AI)](https://towardsai.net/p/machine-learning/mastering-rag-precision-from-table-heavy-pdfs)
- [Multimodal RAG: A Hands-On Guide (DataCamp)](https://www.datacamp.com/tutorial/multimodal-rag)
- [How to Use Multimodal RAG to Extract Text, Images & Tables (AWS Developers, YouTube)](https://www.youtube.com/watch?v=jDFpEnJeSVg)
