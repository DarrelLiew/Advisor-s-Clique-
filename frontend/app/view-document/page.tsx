import ViewDocumentClient from './ViewDocumentClient';

export default function ViewDocumentPage({
  searchParams,
}: {
  searchParams: { url?: string; page?: string };
}) {
  const rawUrl = searchParams.url;
  const page = parseInt(searchParams.page ?? '1', 10) || 1;

  if (!rawUrl) {
    return (
      <div style={{ padding: 32, fontFamily: 'sans-serif' }}>
        <p>No document URL provided.</p>
      </div>
    );
  }

  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(rawUrl);
  } catch {
    return (
      <div style={{ padding: 32, fontFamily: 'sans-serif' }}>
        <p>Invalid document URL.</p>
      </div>
    );
  }

  // Only allow Supabase Storage URLs — prevents open redirect abuse
  let isSafe = false;
  try {
    const parsed = new URL(decodedUrl);
    isSafe = parsed.hostname.endsWith('supabase.co') && parsed.protocol === 'https:';
  } catch { /* malformed URL */ }

  if (!isSafe) {
    return (
      <div style={{ padding: 32, fontFamily: 'sans-serif' }}>
        <p>Invalid document URL.</p>
      </div>
    );
  }

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 16px',
          background: '#1e293b',
          color: 'white',
          fontSize: 14,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <span>Advisors Clique — Document Viewer</span>
        <a
          href={decodedUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#60a5fa', textDecoration: 'none' }}
        >
          Open in new tab ↗
        </a>
      </div>
      <ViewDocumentClient url={decodedUrl} page={page} />
    </div>
  );
}
