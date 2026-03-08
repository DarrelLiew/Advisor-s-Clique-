-- Recreate get_chunks_by_pages function with correct return type.
-- Used by page-expansion in retrieval to fetch full page context
-- around high-confidence vector matches.
DROP FUNCTION IF EXISTS get_chunks_by_pages(uuid[], integer[]);

CREATE OR REPLACE FUNCTION get_chunks_by_pages(doc_ids uuid[], page_nums int[])
RETURNS TABLE(
  document_id uuid,
  filename text,
  page_number int,
  text text,
  metadata jsonb
)
LANGUAGE sql STABLE
AS $$
  SELECT
    dc.document_id,
    d.filename,
    dc.page_number,
    dc.content AS text,
    dc.metadata
  FROM document_chunks dc
  JOIN documents d ON d.id = dc.document_id
  WHERE dc.document_id = ANY(doc_ids)
    AND dc.page_number = ANY(page_nums)
    AND d.deleted_at IS NULL
    AND d.processing_status = 'ready'
  ORDER BY dc.document_id, dc.page_number, dc.chunk_index;
$$;
