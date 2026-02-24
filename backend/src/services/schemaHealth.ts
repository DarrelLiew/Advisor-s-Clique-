import { supabase } from '../lib/supabase';

export async function validateRagSchema(): Promise<void> {
  const { error: tableError } = await supabase
    .from('document_chunks')
    .select('id, document_id, page_number, chunk_index, content, embedding')
    .limit(1);

  if (tableError) {
    throw new Error(`RAG schema check failed for document_chunks: ${tableError.message}`);
  }

  const zeroVector = new Array(1536).fill(0);
  const { error: rpcError } = await supabase.rpc('search_documents', {
    query_embedding: zeroVector,
    match_threshold: 1.1,
    match_count: 1,
    filter_document_ids: null,
  });

  if (rpcError) {
    throw new Error(`RAG schema check failed for search_documents RPC: ${rpcError.message}`);
  }

  console.log('[RAG] schema check passed');
}
