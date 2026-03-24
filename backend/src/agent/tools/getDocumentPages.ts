import { supabase } from '../../lib/supabase';
import type { RetrievedChunk, ToolExecutor } from '../types';

/**
 * Retrieves all chunks from specific pages of a document.
 * Wraps the get_chunks_by_pages() RPC.
 */
export const executeTool: ToolExecutor = async (args, allChunks) => {
  const documentId = String(args.document_id ?? '');
  const pageNumbers = Array.isArray(args.page_numbers)
    ? (args.page_numbers as number[]).map(Number).filter(Number.isFinite)
    : [];

  if (!documentId) {
    return 'Error: document_id is required.';
  }
  if (pageNumbers.length === 0) {
    return 'Error: page_numbers array is required and must contain at least one page number.';
  }

  // Cap page count to prevent overloading context
  const cappedPages = pageNumbers.slice(0, 10);

  try {
    const { data, error } = await supabase.rpc('get_chunks_by_pages', {
      doc_ids: [documentId],
      page_nums: cappedPages,
    });

    if (error) throw error;
    if (!data || data.length === 0) {
      return `No content found for pages ${cappedPages.join(', ')} in this document.`;
    }

    const existingKeys = new Set(
      allChunks.map((c) => `${c.document_id}:${c.page_number}:${c.text.slice(0, 40)}`),
    );

    const lines: string[] = [`Retrieved ${data.length} chunks from pages ${cappedPages.join(', ')}:\n`];

    for (const row of data) {
      const chunk: RetrievedChunk = {
        document_id: row.document_id,
        filename: row.filename,
        page_number: row.page_number,
        text: row.text || '',
        similarity: 0, // page-expanded, not vector-matched
      };

      const key = `${chunk.document_id}:${chunk.page_number}:${chunk.text.slice(0, 40)}`;
      if (!existingKeys.has(key)) {
        allChunks.push(chunk);
        existingKeys.add(key);
      }

      lines.push(
        `[${chunk.filename}, Page ${chunk.page_number}]\n${chunk.text}\n`,
      );
    }

    return lines.join('\n');
  } catch (err: any) {
    return `Error retrieving document pages: ${err.message}`;
  }
};
