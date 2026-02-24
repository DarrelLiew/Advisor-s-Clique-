import { supabase } from '../lib/supabase';

export type ChunkTextColumn = 'text' | 'content';

let cachedColumn: ChunkTextColumn | null = null;

async function columnExists(column: ChunkTextColumn): Promise<boolean> {
  const { error } = await supabase
    .from('document_chunks')
    .select(`id, ${column}`)
    .limit(1);

  return !error;
}

export async function getChunkTextColumn(): Promise<ChunkTextColumn> {
  if (cachedColumn) return cachedColumn;

  if (await columnExists('text')) {
    cachedColumn = 'text';
    return cachedColumn;
  }

  if (await columnExists('content')) {
    cachedColumn = 'content';
    return cachedColumn;
  }

  throw new Error('Neither "text" nor "content" column exists on document_chunks.');
}

