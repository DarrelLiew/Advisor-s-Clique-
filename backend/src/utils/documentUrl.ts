import { supabase } from '../lib/supabase';

const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * Look up document file_path by ID and generate a signed Supabase Storage URL.
 * Returns null if the document is not found or URL generation fails.
 */
export async function getSignedDocumentUrl(documentId: string): Promise<string | null> {
  const { data: document, error } = await supabase
    .from('documents')
    .select('file_path')
    .eq('id', documentId)
    .single();

  if (error || !document) {
    console.error(`[documentUrl] Document not found: ${documentId}`);
    return null;
  }

  const { data, error: urlError } = await supabase.storage
    .from('Documents')
    .createSignedUrl(document.file_path, SIGNED_URL_EXPIRY_SECONDS);

  if (urlError || !data) {
    console.error(`[documentUrl] Failed to generate signed URL for ${documentId}:`, urlError?.message);
    return null;
  }

  return data.signedUrl;
}
