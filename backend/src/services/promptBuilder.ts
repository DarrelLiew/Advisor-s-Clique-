/**
 * Unified prompt builder for both web and Telegram platforms.
 * Ensures the same system prompt logic is used across all interfaces,
 * with only output formatting differing by platform.
 */

export type ChatMode = 'client' | 'learner';
export type OutputFormat = 'markdown' | 'plaintext';

/**
 * Builds a system prompt for the LLM based on context availability, mode, and format.
 *
 * - When context is available (documents found): document-based prompt with mode-specific instructions
 * - When context is missing but is_financial: web fallback prompt
 *
 * @param context - The document context to include in the prompt (or empty string for fallback)
 * @param mode - Chat mode: 'client' (concise) or 'learner' (expanded explanations)
 * @param format - Output format: 'markdown' (web) or 'plaintext' (Telegram)
 * @param usedWebFallback - Whether this is a web fallback (financial Q not in documents)
 * @returns System prompt string to send to the LLM
 */
export function buildSystemPrompt(
  context: string,
  mode: ChatMode,
  format: OutputFormat,
  usedWebFallback: boolean,
): string {
  if (usedWebFallback) {
    // Financial question not covered in uploaded documents — use general knowledge
    return `You are a knowledgeable financial advisory assistant. This question is not covered in the uploaded documents, so answer using your general knowledge.

Start your response with the label "[Web]" on its own line to clearly indicate this answer is not sourced from the uploaded documents.
${format === 'markdown' ? 'Format your response clearly. Be concise, accurate, and helpful.' : 'Plain text only. Be concise, accurate, and helpful.'}`;
  }

  // Document-based answer with mode differentiation
  const baseInstructions = `You are an AI assistant for uploaded documents. You answer questions strictly based on the documents provided below.

Key instructions:
- ALWAYS answer by describing what IS in the documents. Never say "the document does not list", "not explicitly mentioned", or "not provided in the context" if ANY relevant information exists below. Instead, describe what the documents DO contain that relates to the question.
- Answer all questions factually using only the document content provided.
- Do NOT redirect users to external help lines, and do NOT tell the user to "refer to the full document", "check other sections", or "see the complete document" — answer directly and completely from the provided context.
- Do NOT say information "may be found in other sections" or "not included in the provided context" — work only with what you have and present it fully.
${format === 'markdown' ? '- Format using markdown. Use bullet points or numbered lists.' : '- Plain text only. Use * for bullet points.'}
- CRITICAL: After EACH specific fact, claim, or bullet point, immediately add an inline citation showing the page number in square brackets (e.g., [p.5] or [p.3-4]). ONLY cite page numbers that appear in the context headers below — never invent, infer, or guess page numbers for content not present in the provided context.
- Do NOT list sources at the end - citations must be inline next to each point.
- If the answer involves a table (e.g., premium tiers, rate schedules, benefit schedules), include ALL rows you can find in the context. If the table appears incomplete or cut off, add: "Note: This table may be partial - please verify in the source document."
- When reading tables, carefully identify the correct column before extracting values. Do not confuse values across different columns.
- For numeric ranges, percentages, rates, and plan-choice mappings: copy values exactly as written in context. Do NOT infer, interpolate, or shift values between choices/columns.
- Never invent missing rows. If a row/value is not explicitly present in the provided context, state only what is explicitly present.
- If a plan/choice is stated as "Not Applicable" with no explicit exceptions, do not add conditional percentages for that same plan/choice.
- For broad or analytical questions (e.g. "what topics does this cover?", "give me a list of...", "summarise..."), synthesise a comprehensive answer from ALL the relevant sections in the provided context — even if no single chunk directly answers the question. Extract and combine information across multiple pages.
- Only say you cannot answer if the retrieved context contains absolutely no information relevant to the question. A confidentiality notice or disclaimer on one page does not prevent you from describing product features, benefits, or summaries found on other pages.`;

  const modeInstructions = mode === 'learner'
    ? `\n- LEARNER MODE: For each bullet point, provide an expanded explanation (2-4 sentences) drawing from the document context. Explain the reasoning, implications, or background so a junior advisor can fully understand.`
    : `\n- CLIENT MODE: Present ALL relevant information from the documents as bullet points. Keep each point to 1-2 sentences. Do not skip or omit information - include every relevant fact, but state it briefly.\n- CLIENT MODE (NUMERIC ACCURACY): For table-like answers, output one row per explicit source row and do not compress by inferring or merging missing rows.`;

  return `${baseInstructions}${modeInstructions}

Context from documents:
${context}`;
}

/**
 * Post-processes an LLM response for Telegram delivery.
 * Converts markdown formatting to plaintext while preserving citations.
 *
 * @param answer - Raw LLM response (formatted as markdown)
 * @returns Telegram-compatible plaintext version
 */
export function formatForTelegram(answer: string): string {
  let formatted = answer;

  // Strip markdown bold: **text** → text
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '$1');

  // Convert markdown bullets to plaintext: - item → * item (already done by LLM plaintext mode, but handle anyway)
  formatted = formatted.replace(/^- /gm, '* ');

  // Remove markdown headers: ## Header → Header (keep the text)
  formatted = formatted.replace(/^#{1,6}\s+/gm, '');

  // Preserve [p.X] citations as-is — they will be parsed separately to generate Telegram inline keyboard buttons

  return formatted;
}
