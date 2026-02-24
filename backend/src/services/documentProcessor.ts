import { supabase } from '../lib/supabase';
import OpenAI from 'openai';
// @ts-ignore - pdf-parse doesn't have types
import pdfParse from 'pdf-parse';
import { ragConfig } from './ragConfig';

interface DocumentChunk {
  document_id: string;
  page_number: number;
  chunk_index: number;
  text: string;
  embedding?: number[];
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configuration constants
const MAX_FILE_SIZE_MB = 50; // Maximum file size in MB
const MAX_CHUNK_SIZE = ragConfig.chunkSize; // Characters per chunk
const CHUNK_OVERLAP = ragConfig.chunkOverlap; // Overlap between chunks
const BATCH_SIZE = 50; // Chunks per batch
const RATE_LIMIT_DELAY_MS = 1000; // Delay between batches

function findBoundary(text: string, start: number, targetEnd: number): number {
  const minBoundary = Math.max(start + Math.floor(MAX_CHUNK_SIZE * 0.6), start + 1);
  const window = text.slice(minBoundary, targetEnd);
  const boundaries = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', '];

  let best = -1;
  let boundaryLen = 0;

  for (const boundary of boundaries) {
    const idx = window.lastIndexOf(boundary);
    if (idx > best) {
      best = idx;
      boundaryLen = boundary.length;
    }
  }

  if (best >= 0) {
    return minBoundary + best + boundaryLen;
  }

  return targetEnd;
}

/**
 * Download a file from Supabase Storage
 */
async function downloadFileFromStorage(filePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage
    .from('Documents')
    .download(filePath);

  if (error) {
    throw new Error(`Failed to download file: ${error.message}`);
  }

  if (!data) {
    throw new Error('No data received from storage');
  }

  // Convert Blob to Buffer
  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Check file size
  const fileSizeMB = buffer.length / (1024 * 1024);
  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    throw new Error(`File too large (${fileSizeMB.toFixed(2)}MB). Maximum size is ${MAX_FILE_SIZE_MB}MB`);
  }

  console.log(`Downloaded file: ${fileSizeMB.toFixed(2)}MB`);
  return buffer;
}

/**
 * Extract text from PDF buffer with accurate per-page numbering
 */
async function extractTextFromPDF(buffer: Buffer): Promise<Array<{ page_number: number; text: string }>> {
  try {
    const pages: Array<{ page_number: number; text: string }> = [];
    let pageCounter = 0;

    await pdfParse(buffer, {
      max: 0, // Process all pages
      pagerender: (pageData: any) => {
        const pageNum = ++pageCounter;
        return pageData.getTextContent().then((textContent: any) => {
          // Reconstruct text with line breaks based on Y-position changes
          let lastY: number | null = null;
          let text = '';
          for (const item of textContent.items) {
            const y: number | undefined = item.transform?.[5];
            if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 5) {
              text += '\n';
            }
            text += item.str;
            if (y !== undefined) lastY = y;
          }
          const trimmed = text.trim();
          if (trimmed.length > 0) {
            pages.push({ page_number: pageNum, text: trimmed });
          }
          return trimmed;
        });
      },
    });

    console.log(`Extracted text from ${pageCounter} PDF pages, ${pages.length} non-empty`);
    return pages;
  } catch (error: any) {
    console.error('PDF extraction error:', error);
    return [{ page_number: 1, text: `[PDF extraction failed: ${error.message}]` }];
  }
}

/**
 * Chunk a single page into smaller pieces with overlap (memory-efficient generator)
 */
function* chunkPage(
  page: { page_number: number; text: string },
  documentId: string,
  startChunkIndex: number,
  maxChunkSize: number = MAX_CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): Generator<DocumentChunk> {
  const { page_number, text } = page;

  if (!text || text.length === 0) return;

  let chunkIndex = startChunkIndex;

  if (text.length <= maxChunkSize) {
    yield {
      document_id: documentId,
      page_number,
      chunk_index: chunkIndex,
      text,
    };
  } else {
    // Boundary-aware chunking with overlap fallback to hard boundaries.
    let start = 0;
    while (start < text.length) {
      const targetEnd = Math.min(start + maxChunkSize, text.length);
      const end = targetEnd >= text.length
        ? targetEnd
        : findBoundary(text, start, targetEnd);

      const chunkText = text.slice(start, end).trim();
      if (chunkText.length === 0) {
        start = targetEnd;
        continue;
      }

      yield {
        document_id: documentId,
        page_number,
        chunk_index: chunkIndex++,
        text: chunkText,
      };
      
      // Break if we've reached the end
      if (end >= text.length) break;
      
      // Move to next position with overlap
      start = end - overlap;
    }
  }
}

/**
 * Generate embeddings for a batch of chunks
 */
async function generateEmbeddings(chunks: DocumentChunk[]): Promise<DocumentChunk[]> {
  const texts = chunks.map(c => c.text);

  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
      encoding_format: 'float',
    });

    return chunks.map((chunk, index) => ({
      ...chunk,
      embedding: response.data[index].embedding,
    }));
  } catch (error: any) {
    console.error('OpenAI embeddings error:', error);
    throw new Error(`Failed to generate embeddings: ${error.message}`);
  }
}

/**
 * Store chunks with embeddings in Supabase
 */
async function storeChunks(chunks: DocumentChunk[]): Promise<void> {
  // Convert embeddings to proper format for pgvector and map to correct column name
  const chunksToInsert = chunks.map(chunk => ({
    document_id: chunk.document_id,
    page_number: chunk.page_number,
    chunk_index: chunk.chunk_index,
    content: chunk.text,
    embedding: `[${chunk.embedding?.join(',')}]`, // Format as pgvector string
  }));

  const { error } = await supabase
    .from('document_chunks')
    .insert(chunksToInsert);

  if (error) {
    throw new Error(`Failed to store chunks: ${error.message}`);
  }
}

/**
 * Update document status
 */
async function updateDocumentStatus(
  documentId: string,
  status: 'processing' | 'ready' | 'failed',
  totalChunks?: number,
  totalPages?: number,
  errorMessage?: string
): Promise<void> {
  const updateData: any = {
    processing_status: status,
    processed_at: new Date().toISOString(),
  };

  if (totalChunks !== undefined) {
    updateData.total_chunks = totalChunks;
  }

  if (totalPages !== undefined) {
    updateData.total_pages = totalPages;
  }

  if (errorMessage) {
    updateData.error_message = errorMessage;
  }

  const { error } = await supabase
    .from('documents')
    .update(updateData)
    .eq('id', documentId);

  if (error) {
    console.error('Failed to update document status:', error);
  }
}

/**
 * Process a batch of chunks (generate embeddings and store)
 */
async function processBatch(batch: DocumentChunk[], batchNumber: number): Promise<void> {
  console.log(`Processing batch #${batchNumber} with ${batch.length} chunks...`);

  // Generate embeddings
  const chunksWithEmbeddings = await generateEmbeddings(batch);

  // Store in database
  await storeChunks(chunksWithEmbeddings);

  console.log(`Batch #${batchNumber} stored successfully`);
}

/**
 * Main function to process a document (memory-efficient version)
 */
export async function processDocument(documentId: string, filePath: string): Promise<void> {
  console.log(`Starting processing for document ${documentId}`);

  try {
    // Update status to processing
    await updateDocumentStatus(documentId, 'processing');

    // Step 1: Download file
    console.log('Downloading file from storage...');
    const fileBuffer = await downloadFileFromStorage(filePath);

    // Step 2: Extract text
    console.log('Extracting text from PDF...');
    const pages = await extractTextFromPDF(fileBuffer);
    console.log(`Extracted ${pages.length} pages`);

    // Free up memory
    fileBuffer.fill(0);

    // Step 3: Process pages incrementally to avoid memory issues
    console.log('Processing pages in batches...');
    let totalChunks = 0;
    let currentBatch: DocumentChunk[] = [];
    let chunkIndex = 0;
    let batchCount = 0;

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const page = pages[pageIdx];
      console.log(`Processing page ${pageIdx + 1}/${pages.length}...`);

      // Generate chunks for this page
      for (const chunk of chunkPage(page, documentId, chunkIndex)) {
        currentBatch.push(chunk);
        chunkIndex = chunk.chunk_index + 1;

        // When batch is full, process and clear
        if (currentBatch.length >= BATCH_SIZE) {
          await processBatch(currentBatch, ++batchCount);
          totalChunks += currentBatch.length;
          currentBatch = []; // Clear for garbage collection

          // Rate limiting: wait between batches
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        }
      }

      // Clear page text from memory after processing
      pages[pageIdx].text = '';
    }

    // Process any remaining chunks
    if (currentBatch.length > 0) {
      await processBatch(currentBatch, ++batchCount);
      totalChunks += currentBatch.length;
    }

    // Step 4: Update status to ready
    await updateDocumentStatus(documentId, 'ready', totalChunks, pages.length);
    console.log(`Document ${documentId} processed successfully (${totalChunks} chunks)`);

  } catch (error: any) {
    console.error(`Failed to process document ${documentId}:`, error);
    await updateDocumentStatus(documentId, 'failed', undefined, undefined, error.message);
    throw error;
  }
}

/**
 * Delete all chunks for a document
 */
export async function deleteDocumentChunks(documentId: string): Promise<void> {
  const { error } = await supabase
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId);

  if (error) {
    throw new Error(`Failed to delete chunks: ${error.message}`);
  }
}
