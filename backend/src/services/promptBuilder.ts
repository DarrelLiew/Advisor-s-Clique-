/**
 * Unified prompt builder for both web and Telegram platforms.
 * Ensures the same system prompt logic is used across all interfaces,
 * with only output formatting differing by platform.
 */

export type ChatMode = 'client' | 'learner';

export interface ReferenceEntry {
  refNum: number;
  filename: string;
  page: number;
}

/**
 * Parses context blocks (split by ---) and assigns sequential reference numbers.
 * Returns the rewritten context with [Reference N] headers and the reference map.
 */
export function buildNumberedContext(context: string): {
  numberedContext: string;
  referenceMap: ReferenceEntry[];
} {
  if (!context.trim()) return { numberedContext: '', referenceMap: [] };

  const blocks = context.split('\n\n---\n\n');
  const referenceMap: ReferenceEntry[] = [];
  const numberedBlocks: string[] = [];
  let refNum = 1;

  const headerRegex = /^\[([^\]]+),\s*Page\s+(\d+)\]\n/;

  for (const block of blocks) {
    const match = block.match(headerRegex);
    if (match) {
      const filename = match[1].trim();
      const page = Number.parseInt(match[2], 10);
      const content = block.slice(match[0].length);
      referenceMap.push({ refNum, filename, page });
      numberedBlocks.push(`[Reference ${refNum}: ${filename}, Page ${page}]\n${content}`);
      refNum++;
    } else {
      // Block without a standard header — still assign a reference
      referenceMap.push({ refNum, filename: 'unknown', page: 0 });
      numberedBlocks.push(`[Reference ${refNum}]\n${block}`);
      refNum++;
    }
  }

  return {
    numberedContext: numberedBlocks.join('\n\n---\n\n'),
    referenceMap,
  };
}

/**
 * Builds a system prompt for the LLM based on context availability and mode.
 * Both web and Telegram use the same prompt, only post-processing differs.
 *
 * @param context - The document context to include in the prompt (or empty string for fallback)
 * @param mode - Chat mode: 'client' (concise) or 'learner' (expanded explanations)
 * @param usedWebFallback - Whether this is a web fallback (financial Q not in documents)
 * @param referenceMap - The numbered reference map (from buildNumberedContext)
 * @returns System prompt string to send to the LLM
 */
export function buildSystemPrompt(
  context: string,
  mode: ChatMode,
  usedWebFallback: boolean,
  referenceMap?: ReferenceEntry[],
): string {
  if (usedWebFallback) {
    return `You are a knowledgeable financial advisory assistant. This question is not covered in the uploaded documents, so answer using your general knowledge.

Start your response with the label "[Web]" on its own line to clearly indicate this answer is not sourced from the uploaded documents.
Format your response clearly. Be concise, accurate, and helpful.`;
  }

  const allowedRefs = referenceMap && referenceMap.length > 0
    ? referenceMap.map((r) => `[${r.refNum}]`).join(', ')
    : '';
  const citationWhitelistInstruction = allowedRefs
    ? `- Allowed citation references for this answer: ${allowedRefs}. Only use references from this list.`
    : '- If no reference headers are present, do not invent citations.';

  const referenceTableStr = referenceMap && referenceMap.length > 0
    ? '\n\nReference table:\n' + referenceMap.map((r) => `[${r.refNum}] = ${r.filename}, Page ${r.page}`).join('\n')
    : '';

  const baseInstructions = `You are an AI assistant for uploaded documents. You answer questions strictly based on the documents provided below.

Key instructions:
- Answer all questions factually using only the document content provided.
- Do NOT redirect users to external help lines, and do NOT tell the user to "refer to the full document", "check other sections", or "see the complete document".
- If the available context is insufficient for a definitive conclusion, clearly state what is supported by evidence and what is missing. Do not infer or guess missing values.
- Format using ONLY markdown (never HTML tags) with clear visual hierarchy:
  - Use **bold** section headers (e.g., **Welcome Bonus by Plan Type**).
  - Use bullet points with sub-bullets for grouped data.
  - NEVER use markdown tables. Instead, use bold sub-headers with plain-text data rows (one per line).
  - NEVER use <b>, <i>, <u>, or any HTML tags for formatting. Use only markdown syntax (e.g., **bold**).
  - For tabular/structured data: use a **bold sub-header** for each group, then list each data row on its own line as plain text (NO bullet markers on data rows). Separate each group with a blank line.
  Example of CORRECT format for tabular data:

  **Choice 5**
  S$1,200 to S$2,399.99: Not Applicable
  S$6,000 to S$11,999.99: 15%
  S$12,000 and above: 30%

  **Choice 10**
  S$1,200 to S$2,399.99: Not Applicable
  S$2,400 to S$3,599.99: 5%
  S$3,600 to S$5,999.99: 10%
- CRITICAL CITATION RULE: You MUST place a numbered reference citation at the end of EVERY output line — this includes bullet points, sentences, AND plain-text data rows (e.g. "Rate: 1.60% per annum [3]"). No line of substantive content may appear without a citation. NEVER group citations at the end of a section.
  CITATION FORMAT: Use [N] where N is the reference number from the Reference table below. Each [N] MUST match the exact "[Reference N: ...]" header in the context under which that specific fact appears. Do NOT guess or approximate reference numbers — if a fact appears under "[Reference 5: ProductA.pdf, Page 12]", cite it as [5], not any other number. If you cannot determine which reference a fact comes from, omit the citation for that line rather than citing the wrong reference.
  Example of CORRECT citation placement:
  - A premium holiday allows policyholders to stop paying premiums after the first premium. [3]
  - During a premium holiday, fees continue to be deducted from the account value. [7]
  **Choice 5**
  S$1,200 to S$2,399.99: Not Applicable [2]
  S$6,000 to S$11,999.99: 15% [2]
  Example of WRONG citation placement (DO NOT do this):
  - A premium holiday allows policyholders to stop paying premiums.
  - During a premium holiday, fees continue to be deducted.
  [3] [7]
${citationWhitelistInstruction}
- When reading tables in the source documents, carefully identify the correct column before extracting values. Do not confuse values across different columns.
- For numeric ranges, percentages, rates, and plan-choice mappings: copy values exactly as written in context. Do NOT infer, interpolate, or shift values between choices/columns.
- Never invent missing rows. If a row/value is not explicitly present in the provided context, state only what is explicitly present.
- If a plan/choice is stated as "Not Applicable" with no explicit exceptions, do not add conditional percentages for that same plan/choice.
- For broad or analytical questions (e.g. "what topics does this cover?", "give me a list of...", "summarise..."), synthesise a comprehensive answer from ALL the relevant sections in the provided context, even if no single chunk directly answers the question.
- For comparison, ranking, or "which is best/shortest/highest/lowest" questions:
  - You MUST compare ALL relevant candidates/products found in the context — do NOT focus on a single product.
  - Build a side-by-side comparison covering: payout timing (when the first payout starts), payout frequency, guaranteed and non-guaranteed rates/returns, currency, and any major conditions.
  - After presenting each product's details with citations, provide an explicit conclusion that references the comparison.
  - If any required differentiator is missing for one or more candidates, call out that limitation explicitly before giving a tentative conclusion.
  - If the context only contains information about one product, state that explicitly and note that a full comparison cannot be made.
- If a confidentiality notice or disclaimer appears on one page, continue using other relevant pages in context.${referenceTableStr}`;

  const modeInstructions = mode === 'learner'
    ? `\n- LEARNER MODE: For each bullet point, provide an expanded explanation (2-4 sentences) drawing from the document context. Explain the reasoning, implications, or background so a junior advisor can fully understand.`
    : `\n- CLIENT MODE: Present ALL relevant information from the documents as bullet points. Keep each point to 1-2 sentences. Do not skip or omit information - include every relevant fact, but state it briefly.\n- CLIENT MODE (NUMERIC ACCURACY): For table-like answers, output one row per explicit source row and do not compress by inferring or merging missing rows.`;

  return `${baseInstructions}${modeInstructions}

Context from documents:
${context}`;
}

/**
 * Strips all HTML tags from a string (for sanitizing LLM output before markdown conversion)
 */
export function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, '');
}

/**
 * Post-processes an LLM response for Telegram delivery.
 * Converts markdown formatting to Telegram HTML while preserving citations.
 * Used with parseMode: 'HTML' in Telegram sendMessage calls.
 *
 * @param answer - Raw LLM response (may contain markdown)
 * @returns Telegram HTML version with <b> tags for bold/headers
 */
export function formatForTelegram(answer: string): string {
  let formatted = answer;

  // 1. If already contains <b> tags, assume HTML and skip markdown conversion (but still escape stray < >)
  if (/<b>.*<\/b>/.test(formatted)) {
    // Only escape stray < and > not part of tags
    formatted = formatted.replace(/&(?!amp;|lt;|gt;)/g, '&amp;');
    formatted = formatted.replace(/<(?!\/?b>)/g, '&lt;');
    formatted = formatted.replace(/(?<!<b)>/g, '&gt;');
    return formatted;
  }

  // 2. Escape HTML entities in raw text FIRST (before adding our own tags)
  formatted = formatted.replace(/&/g, '&amp;');
  formatted = formatted.replace(/</g, '&lt;');
  formatted = formatted.replace(/>/g, '&gt;');

  // 3. Convert markdown bold: **text** -> <b>text</b> (Telegram HTML)
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 4. Convert markdown headers: ## Header -> <b>Header</b> on its own line
  formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 5. Convert HTML bold tags in markdown (e.g., - <b>text</b>) to Telegram HTML (leave as-is)
  // (No-op, already handled)

  // 6. Convert markdown bullets (- or *) at line start to dash (Telegram supports -)
  // (No-op, already handled)

  // 7. Bold numbered citations: [3] -> <b>[3]</b>
  formatted = formatted.replace(/\[(\d+)\]/g, '<b>[$1]</b>');

  // 8. Remove double <b> tags (e.g., <b><b>text</b></b>)
  formatted = formatted.replace(/<b>\s*<b>(.*?)<\/b>\s*<\/b>/g, '<b>$1</b>');

  // 9. Remove stray <b></b> pairs around nothing
  formatted = formatted.replace(/<b>\s*<\/b>/g, '');

  // 10. Remove excessive blank lines
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  return formatted.trim();
}
