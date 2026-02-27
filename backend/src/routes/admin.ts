import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { authenticateUser, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { processDocument } from '../services/documentProcessor';
import { createAuditLog } from '../utils/auditLog';
import { uploadLimiter, rateLimitMiddleware } from '../utils/rateLimiter';
import {
  checkQuestionAnalyticsMetadataAvailable,
  getAnalyticsInsertTelemetrySnapshot,
} from '../utils/analyticsLog';

const router = Router();

const ANALYTICS_TIMEZONE = 'Asia/Singapore';
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

const FINANCIAL_UNANSWERED_OUTCOMES = new Set(['web_fallback', 'no_chunks', 'no_direct_answer_in_docs']);
const FINANCIAL_ANALYTICS_OUTCOMES = new Set(['success', 'web_fallback', 'no_chunks', 'no_direct_answer_in_docs']);
const OFF_TOPIC_OUTCOME = 'domain_gate_reject';
const DEFAULT_FALLBACK_CATEGORY = 'Client Recommendation Wording';

const QUERY_CATEGORIES: Array<{ category: string; keywords: string[] }> = [
  {
    category: 'KYC & Suitability',
    keywords: ['kyc', 'suitability', 'risk profile', 'risk tolerance', 'time horizon', 'know your client', 'client profile'],
  },
  {
    category: 'Product Features & Eligibility',
    keywords: ['gic', 'mutual fund', 'etf', 'annuity', 'bond', 'stock', 'equity', 'eligibility', 'minimum investment', 'premium', 'bonus'],
  },
  {
    category: 'Portfolio Construction & Allocation',
    keywords: ['allocation', 'rebalance', 'diversification', 'portfolio mix', 'asset mix', 'model portfolio', 'weighting'],
  },
  {
    category: 'Fees & Compensation',
    keywords: ['fee', 'fees', 'commission', 'trailer', 'expense ratio', 'mer', 'spread', 'advisory fee'],
  },
  {
    category: 'Performance & Benchmarks',
    keywords: ['performance', 'return', 'benchmark', 'alpha', 'volatility', 'drawdown', 'sharpe'],
  },
  {
    category: 'Compliance & Disclosure',
    keywords: ['compliance', 'regulation', 'regulatory', 'disclosure', 'conflict', 'fiduciary', 'ciro', 'iiroc', 'aml'],
  },
  {
    category: 'Account Operations & Transactions',
    keywords: ['withdrawal', 'deposit', 'transfer', 'settlement', 'redemption', 'subscription', 'trade', 'transaction'],
  },
  {
    category: 'Client Recommendation Wording',
    keywords: ['recommend', 'proposal', 'email client', 'explain to client', 'client wording', 'how to say'],
  },
];

const GROUPING_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'am', 'was', 'were', 'be', 'to', 'of', 'for', 'in', 'on', 'at',
  'with', 'about', 'how', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'can', 'could', 'should', 'would',
  'do', 'does', 'did', 'any', 'there', 'it', 'that', 'this', 'these', 'those', 'please', 'me', 'my', 'we', 'our',
  'you', 'your', 'i',
]);

interface AnalyticsQueryRow {
  query_text: string;
  timestamp: string;
  metadata: Record<string, unknown> | null;
}

interface GroupedQuestion {
  question: string;
  count: number;
  category: string;
  last_asked_at: string;
}

function getSingleQueryParam(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function parsePositiveInt(value: unknown, defaultValue: number, maxValue: number): number {
  const raw = getSingleQueryParam(value);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

function categorizeQueryText(queryText: string): string {
  const normalized = queryText.toLowerCase();
  let bestCategory = DEFAULT_FALLBACK_CATEGORY;
  let bestScore = 0;

  for (const bucket of QUERY_CATEGORIES) {
    let score = 0;
    for (const keyword of bucket.keywords) {
      if (normalized.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = bucket.category;
    }
  }

  return bestCategory;
}

function getSgNowParts(): { year: number; monthIndex: number } {
  const sgNow = new Date(Date.now() + SGT_OFFSET_MS);
  return {
    year: sgNow.getUTCFullYear(),
    monthIndex: sgNow.getUTCMonth(),
  };
}

function getSgMonthRangeUtc(year: number, monthIndex: number): { startIso: string; endIso: string; monthKey: string } {
  const startMs = Date.UTC(year, monthIndex, 1) - SGT_OFFSET_MS;
  const endMs = Date.UTC(year, monthIndex + 1, 1) - SGT_OFFSET_MS;
  const monthKey = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 7);

  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    monthKey,
  };
}

function getSgMonthKeyFromTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(date.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 7);
}

function buildRecentSgMonthKeys(months: number): string[] {
  const { year, monthIndex } = getSgNowParts();
  const monthKeys: string[] = [];

  for (let offset = months - 1; offset >= 0; offset--) {
    const monthDate = new Date(Date.UTC(year, monthIndex - offset, 1));
    monthKeys.push(getMonthKey(monthDate));
  }

  return monthKeys;
}

function getMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function getRecentSgMonthRangeUtc(months: number): { startIso: string; endIso: string; monthKeys: string[] } {
  const { year, monthIndex } = getSgNowParts();
  const startMs = Date.UTC(year, monthIndex - (months - 1), 1) - SGT_OFFSET_MS;
  const endMs = Date.UTC(year, monthIndex + 1, 1) - SGT_OFFSET_MS;
  const monthKeys = buildRecentSgMonthKeys(months);
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    monthKeys,
  };
}

function getCurrentSgMonthRangeUtc(): { startIso: string; endIso: string; monthKey: string } {
  const { year, monthIndex } = getSgNowParts();
  return getSgMonthRangeUtc(year, monthIndex);
}

function getOutcome(metadata: Record<string, unknown> | null | undefined): string | null {
  const outcome = metadata?.outcome;
  return typeof outcome === 'string' ? outcome : null;
}

function normalizeForQuestionGrouping(query: string): string {
  const cleaned = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const tokens = cleaned
    .split(' ')
    .filter((token) => token.length > 1 && !GROUPING_STOPWORDS.has(token));

  if (tokens.length === 0) return cleaned;
  return tokens.join(' ');
}

function buildTokenSet(text: string): Set<string> {
  return new Set(text.split(' ').filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function pickMostFrequentKey(counts: Map<string, number>, preferShorterText: boolean): string {
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (preferShorterText && a[0].length !== b[0].length) return a[0].length - b[0].length;
    return a[0].localeCompare(b[0]);
  });
  return entries[0]?.[0] ?? '';
}

function mergeCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, count] of source.entries()) {
    target.set(key, (target.get(key) || 0) + count);
  }
}

function buildCommonQuestions(rows: AnalyticsQueryRow[], limit: number): GroupedQuestion[] {
  interface ExactGroup {
    normalized: string;
    tokens: Set<string>;
    count: number;
    lastAskedAt: string;
    originalCounts: Map<string, number>;
    categoryCounts: Map<string, number>;
  }

  interface Cluster {
    representativeTokens: Set<string>;
    representativeWeight: number;
    count: number;
    lastAskedAt: string;
    originalCounts: Map<string, number>;
    categoryCounts: Map<string, number>;
  }

  const exactGroupMap = new Map<string, ExactGroup>();

  for (const row of rows) {
    const question = row.query_text?.trim();
    if (!question) continue;

    const normalized = normalizeForQuestionGrouping(question);
    if (!normalized) continue;

    const tokens = buildTokenSet(normalized);
    if (tokens.size === 0) continue;

    const existing = exactGroupMap.get(normalized);
    if (!existing) {
      const categoryCounts = new Map<string, number>();
      categoryCounts.set(categorizeQueryText(question), 1);

      exactGroupMap.set(normalized, {
        normalized,
        tokens,
        count: 1,
        lastAskedAt: row.timestamp,
        originalCounts: new Map<string, number>([[question, 1]]),
        categoryCounts,
      });
      continue;
    }

    existing.count += 1;
    if (row.timestamp > existing.lastAskedAt) existing.lastAskedAt = row.timestamp;
    existing.originalCounts.set(question, (existing.originalCounts.get(question) || 0) + 1);
    const category = categorizeQueryText(question);
    existing.categoryCounts.set(category, (existing.categoryCounts.get(category) || 0) + 1);
  }

  const exactGroups = Array.from(exactGroupMap.values()).sort((a, b) => b.count - a.count);
  const clusters: Cluster[] = [];

  for (const group of exactGroups) {
    let bestIndex = -1;
    let bestSimilarity = 0;

    for (let i = 0; i < clusters.length; i++) {
      const score = jaccardSimilarity(group.tokens, clusters[i].representativeTokens);
      if (score >= 0.72 && score > bestSimilarity) {
        bestSimilarity = score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      clusters.push({
        representativeTokens: new Set(group.tokens),
        representativeWeight: group.count,
        count: group.count,
        lastAskedAt: group.lastAskedAt,
        originalCounts: new Map(group.originalCounts),
        categoryCounts: new Map(group.categoryCounts),
      });
      continue;
    }

    const cluster = clusters[bestIndex];
    cluster.count += group.count;
    if (group.lastAskedAt > cluster.lastAskedAt) cluster.lastAskedAt = group.lastAskedAt;
    mergeCounts(cluster.originalCounts, group.originalCounts);
    mergeCounts(cluster.categoryCounts, group.categoryCounts);

    if (group.count > cluster.representativeWeight) {
      cluster.representativeTokens = new Set(group.tokens);
      cluster.representativeWeight = group.count;
    }
  }

  return clusters
    .map((cluster) => ({
      question: pickMostFrequentKey(cluster.originalCounts, true),
      count: cluster.count,
      category: pickMostFrequentKey(cluster.categoryCounts, false) || DEFAULT_FALLBACK_CATEGORY,
      last_asked_at: cluster.lastAskedAt,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.last_asked_at !== a.last_asked_at) return b.last_asked_at.localeCompare(a.last_asked_at);
      return a.question.localeCompare(b.question);
    })
    .slice(0, limit);
}

async function resolveAnalyticsDiagnostics(): Promise<{
  metadataAvailable: boolean;
  dataQuality: 'complete' | 'partial';
  telemetry: ReturnType<typeof getAnalyticsInsertTelemetrySnapshot>;
}> {
  try {
    const metadataAvailable = await checkQuestionAnalyticsMetadataAvailable();
    return {
      metadataAvailable,
      dataQuality: metadataAvailable ? 'complete' : 'partial',
      telemetry: getAnalyticsInsertTelemetrySnapshot(),
    };
  } catch (error: any) {
    console.error('Analytics metadata check failed:', error);
    return {
      metadataAvailable: false,
      dataQuality: 'partial',
      telemetry: getAnalyticsInsertTelemetrySnapshot(),
    };
  }
}

// Apply auth middleware to all admin routes
router.use(authenticateUser);
router.use(requireAdmin);

// Create user account
router.post('/users/create', async (req: AuthenticatedRequest, res) => {
  try {
    const { email, role = 'user', send_magic_link = true } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const ALLOWED_ROLES = ['user', 'admin'];
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Role must be "user" or "admin"' });
    }

    // Create user via Supabase Admin API
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      email_confirm: true, // Skip email confirmation
      user_metadata: { role },
    });

    if (authError) throw authError;

    // Profile is auto-created via trigger

    // Generate magic link if requested
    let magicLink = null;
    if (send_magic_link) {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: email.trim(),
      });

      if (!linkError && linkData) {
        magicLink = linkData.properties.action_link;
      }
    }

    await createAuditLog({
      userId: req.user!.id,
      action: 'user_created',
      resourceType: 'user',
      resourceId: authUser.user.id,
      metadata: { email: email.trim(), role },
    });

    res.json({
      success: true,
      user: {
        id: authUser.user.id,
        email: email.trim(),
        role,
      },
      magic_link: magicLink,
    });
  } catch (error: any) {
    console.error('Create user error:', error);
    res.status(500).json({ error: error.message || 'Failed to create user' });
  }
});

// List all users
router.get('/users', async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(`
        id,
        role,
        telegram_id,
        created_at,
        metadata
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get emails from auth.users (requires service role)
    const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();

    if (authError) throw authError;

    const usersMap = new Map(authUsers.users.map(u => [u.id, u]));

    const users = data.map(profile => ({
      ...profile,
      email: usersMap.get(profile.id)?.email,
      telegram_linked: !!profile.telegram_id,
    }));

    res.json({ users });
  } catch (error: any) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Upload document
router.post(
  '/documents/upload',
  rateLimitMiddleware(uploadLimiter, (req: any) => req.user?.id || req.ip || 'unknown'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { filename, file_data, mime_type = 'application/pdf' } = req.body;

      if (!filename || !file_data) {
        return res.status(400).json({ error: 'Filename and file_data required' });
      }

      // Validate mime_type — only PDFs accepted
      const ALLOWED_MIME_TYPES = ['application/pdf'];
      if (!ALLOWED_MIME_TYPES.includes(mime_type)) {
        return res.status(400).json({ error: 'Only PDF files are accepted' });
      }

      // Sanitize filename — strip path traversal / unsafe chars
      const sanitizedFilename = (filename as string)
        .replace(/[^a-zA-Z0-9._\-\s]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 200);

      if (!sanitizedFilename || sanitizedFilename.length === 0) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      // Validate file_data is a non-empty string
      if (typeof file_data !== 'string' || file_data.length === 0) {
        return res.status(400).json({ error: 'file_data must be a non-empty base64 string' });
      }

      // Generate file path using sanitized filename
      const timestamp = Date.now();
      const filePath = `documents/${timestamp}_${sanitizedFilename}`;

      // Upload to Supabase Storage (bucket name is 'Documents' with capital D)
      const fileBuffer = Buffer.from(file_data, 'base64');

      const { error: uploadError } = await supabase.storage
        .from('Documents')
        .upload(filePath, fileBuffer, {
          contentType: mime_type,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      // Create document record
      const { data: document, error: docError } = await supabase
        .from('documents')
        .insert({
          filename: sanitizedFilename,
          file_path: filePath,
          mime_type,
          uploaded_by: req.user!.id,
          processing_status: 'pending',
        })
        .select()
        .single();

      if (docError) throw docError;

      // Trigger document processing asynchronously
      processDocument(document.id, filePath)
        .catch(error => {
          console.error('Document processing failed:', error);
          // Error is already logged in the database by processDocument
        });

      await createAuditLog({
        userId: req.user!.id,
        action: 'document_uploaded',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { filename: sanitizedFilename },
      });

      res.json({
        success: true,
        document: {
          id: document.id,
          filename: document.filename,
          processing_status: document.processing_status,
        },
      });
    } catch (error: any) {
      console.error('Upload error:', error);
      res.status(500).json({
        error: error.message || 'Failed to upload document',
      });
    }
  }
);

// List documents
router.get('/documents', async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .order('uploaded_at', { ascending: false });

    if (error) throw error;

    res.json({ documents: data });
  } catch (error: any) {
    console.error('List documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Get document status
router.get('/documents/:id/status', async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('documents')
      .select('processing_status, error_message, total_chunks, total_pages')
      .eq('id', id)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Get document status error:', error);
    res.status(500).json({ error: 'Failed to fetch document status' });
  }
});

// Delete document
router.delete('/documents/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    // Get document info
    const { data: document, error: fetchError } = await supabase
      .from('documents')
      .select('file_path')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    // Delete from storage (bucket name is 'Documents')
    const { error: storageError } = await supabase.storage
      .from('Documents')
      .remove([document.file_path]);

    if (storageError) {
      console.error('Storage delete error:', storageError);
      // Continue even if storage delete fails
    }

    // Delete document record (cascades to chunks)
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    await createAuditLog({
      userId: req.user!.id,
      action: 'document_deleted',
      resourceType: 'document',
      resourceId: id,
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Re-process document (re-chunk and re-embed with current ragConfig settings)
router.post('/documents/:id/reprocess', async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const { data: document, error: fetchError } = await supabase
      .from('documents')
      .select('id, file_path, processing_status')
      .eq('id', id)
      .single();

    if (fetchError || !document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (document.processing_status === 'processing') {
      return res.status(409).json({ error: 'Document is already being processed' });
    }

    // Delete existing chunks
    const { error: chunksError } = await supabase
      .from('document_chunks')
      .delete()
      .eq('document_id', id);

    if (chunksError) throw chunksError;

    // Reset status to pending
    const { error: resetError } = await supabase
      .from('documents')
      .update({ processing_status: 'pending', error_message: null })
      .eq('id', id);

    if (resetError) throw resetError;

    // Re-trigger processing asynchronously
    processDocument(id, document.file_path)
      .catch((error) => {
        console.error('Document reprocess failed:', error);
      });

    res.json({ success: true, message: 'Reprocessing started' });
  } catch (error: any) {
    console.error('Reprocess document error:', error);
    res.status(500).json({ error: 'Failed to start reprocessing' });
  }
});

// Dashboard stats
router.get('/dashboard/stats', async (req: AuthenticatedRequest, res) => {
  try {
    // Get total users
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const totalUsers = authUsers?.users.length || 0;

    // Get total documents
    const { count: totalDocuments } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true });

    // Get documents by status
    const { data: documents } = await supabase
      .from('documents')
      .select('processing_status');

    const documentsByStatus = {
      pending: 0,
      processing: 0,
      ready: 0,
      failed: 0,
    };

    documents?.forEach(doc => {
      if (doc.processing_status in documentsByStatus) {
        documentsByStatus[doc.processing_status as keyof typeof documentsByStatus]++;
      }
    });

    // Get total questions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { count: questionsLast30Days } = await supabase
      .from('question_analytics')
      .select('*', { count: 'exact', head: true })
      .gte('timestamp', thirtyDaysAgo.toISOString());

    res.json({
      total_users: totalUsers,
      total_documents: totalDocuments || 0,
      documents_by_status: documentsByStatus,
      questions_last_30_days: questionsLast30Days || 0,
    });
  } catch (error: any) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// Monthly analytics
router.get('/analytics/monthly', async (_req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp, query_text')
      .gte('timestamp', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
      .order('timestamp', { ascending: true });

    if (error) throw error;

    // Group by month
    const monthlyData: Record<string, number> = {};
    data?.forEach(item => {
      const month = item.timestamp.substring(0, 7); // YYYY-MM
      monthlyData[month] = (monthlyData[month] || 0) + 1;
    });

    const chartData = Object.entries(monthlyData).map(([month, count]) => ({
      month,
      questions: count,
    }));

    res.json({ data: chartData });
  } catch (error: any) {
    console.error('Monthly analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Financial unanswered analytics by month (web_fallback + no_chunks)
router.get('/analytics/unanswered', async (req: AuthenticatedRequest, res) => {
  try {
    const months = parsePositiveInt(req.query.months, 3, 24);
    const { monthKeys, startIso, endIso } = getRecentSgMonthRangeUtc(months);
    const diagnostics = await resolveAnalyticsDiagnostics();

    if (!diagnostics.metadataAvailable) {
      return res.json({
        data: monthKeys.map((month) => ({ month, count: 0 })),
        data_quality: diagnostics.dataQuality,
        diagnostics: {
          metadata_available: diagnostics.metadataAvailable,
          timezone: ANALYTICS_TIMEZONE,
          telemetry: diagnostics.telemetry,
        },
      });
    }

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp, metadata')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .order('timestamp', { ascending: true });

    if (error) throw error;

    const counts = monthKeys.reduce<Record<string, number>>((acc, month) => {
      acc[month] = 0;
      return acc;
    }, {});

    for (const row of (data ?? []) as Array<{ timestamp: string; metadata: Record<string, unknown> | null }>) {
      const month = getSgMonthKeyFromTimestamp(row.timestamp);
      if (!month || !(month in counts)) continue;

      const outcome = getOutcome(row.metadata);
      if (outcome && FINANCIAL_UNANSWERED_OUTCOMES.has(outcome)) {
        counts[month] += 1;
      }
    }

    res.json({
      data: monthKeys.map((month) => ({
        month,
        count: counts[month] ?? 0,
      })),
      data_quality: diagnostics.dataQuality,
      diagnostics: {
        metadata_available: diagnostics.metadataAvailable,
        timezone: ANALYTICS_TIMEZONE,
        telemetry: diagnostics.telemetry,
      },
    });
  } catch (error: any) {
    console.error('Unanswered analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch unanswered analytics' });
  }
});

// Off-topic rejected analytics by month (domain_gate_reject only)
router.get('/analytics/off-topic-rejected', async (req: AuthenticatedRequest, res) => {
  try {
    const months = parsePositiveInt(req.query.months, 3, 24);
    const { monthKeys, startIso, endIso } = getRecentSgMonthRangeUtc(months);
    const { monthKey: currentMonthKey } = getCurrentSgMonthRangeUtc();
    const diagnostics = await resolveAnalyticsDiagnostics();

    if (!diagnostics.metadataAvailable) {
      return res.json({
        data: monthKeys.map((month) => ({ month, count: 0 })),
        current_month_count: 0,
        data_quality: diagnostics.dataQuality,
        diagnostics: {
          metadata_available: diagnostics.metadataAvailable,
          timezone: ANALYTICS_TIMEZONE,
          telemetry: diagnostics.telemetry,
        },
      });
    }

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp, metadata')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .order('timestamp', { ascending: true });

    if (error) throw error;

    const counts = monthKeys.reduce<Record<string, number>>((acc, month) => {
      acc[month] = 0;
      return acc;
    }, {});

    for (const row of (data ?? []) as Array<{ timestamp: string; metadata: Record<string, unknown> | null }>) {
      const month = getSgMonthKeyFromTimestamp(row.timestamp);
      if (!month || !(month in counts)) continue;
      if (getOutcome(row.metadata) === OFF_TOPIC_OUTCOME) {
        counts[month] += 1;
      }
    }

    res.json({
      data: monthKeys.map((month) => ({
        month,
        count: counts[month] ?? 0,
      })),
      current_month_count: counts[currentMonthKey] ?? 0,
      data_quality: diagnostics.dataQuality,
      diagnostics: {
        metadata_available: diagnostics.metadataAvailable,
        timezone: ANALYTICS_TIMEZONE,
        telemetry: diagnostics.telemetry,
      },
    });
  } catch (error: any) {
    console.error('Off-topic analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch off-topic analytics' });
  }
});

// Commonly asked financial questions (current Singapore calendar month)
router.get('/analytics/common-questions', async (req: AuthenticatedRequest, res) => {
  try {
    const period = getSingleQueryParam(req.query.period) || 'current_month';
    if (period !== 'current_month') {
      return res.status(400).json({ error: 'Only period=current_month is supported' });
    }

    const limit = parsePositiveInt(req.query.limit, 10, 25);
    const { startIso, endIso } = getCurrentSgMonthRangeUtc();
    const diagnostics = await resolveAnalyticsDiagnostics();

    if (!diagnostics.metadataAvailable) {
      return res.json({
        data: [],
        window: { type: period, timezone: ANALYTICS_TIMEZONE },
        data_quality: diagnostics.dataQuality,
        diagnostics: {
          metadata_available: diagnostics.metadataAvailable,
          timezone: ANALYTICS_TIMEZONE,
          telemetry: diagnostics.telemetry,
        },
      });
    }

    const { data, error } = await supabase
      .from('question_analytics')
      .select('query_text, timestamp, metadata')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .order('timestamp', { ascending: false })
      .limit(2000);

    if (error) throw error;

    const financialRows = ((data ?? []) as AnalyticsQueryRow[])
      .filter((row) => {
        const outcome = getOutcome(row.metadata);
        return outcome !== null && FINANCIAL_ANALYTICS_OUTCOMES.has(outcome);
      });

    const grouped = buildCommonQuestions(financialRows, limit);

    res.json({
      data: grouped,
      window: { type: period, timezone: ANALYTICS_TIMEZONE },
      data_quality: diagnostics.dataQuality,
      diagnostics: {
        metadata_available: diagnostics.metadataAvailable,
        timezone: ANALYTICS_TIMEZONE,
        telemetry: diagnostics.telemetry,
      },
    });
  } catch (error: any) {
    console.error('Common questions analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch common questions' });
  }
});

// Top query categories (current Singapore calendar month, financial outcomes only)
router.get('/analytics/top-queries', async (req: AuthenticatedRequest, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 10, 25);
    const { startIso, endIso } = getCurrentSgMonthRangeUtc();
    const diagnostics = await resolveAnalyticsDiagnostics();

    if (!diagnostics.metadataAvailable) {
      return res.json({
        data: [],
        window: { type: 'current_month', timezone: ANALYTICS_TIMEZONE },
        data_quality: diagnostics.dataQuality,
        diagnostics: {
          metadata_available: diagnostics.metadataAvailable,
          timezone: ANALYTICS_TIMEZONE,
          telemetry: diagnostics.telemetry,
        },
      });
    }

    const { data, error } = await supabase
      .from('question_analytics')
      .select('query_text, metadata')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .order('timestamp', { ascending: false })
      .limit(2000);

    if (error) throw error;

    const categoryCounts: Record<string, number> = {};
    for (const row of (data ?? []) as Array<{ query_text: string; metadata: Record<string, unknown> | null }>) {
      const outcome = getOutcome(row.metadata);
      if (!outcome || !FINANCIAL_ANALYTICS_OUTCOMES.has(outcome)) continue;
      const category = categorizeQueryText(row.query_text || '');
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    const ranked = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([category, count]) => ({ category, count }));

    res.json({
      data: ranked,
      window: { type: 'current_month', timezone: ANALYTICS_TIMEZONE },
      data_quality: diagnostics.dataQuality,
      diagnostics: {
        metadata_available: diagnostics.metadataAvailable,
        timezone: ANALYTICS_TIMEZONE,
        telemetry: diagnostics.telemetry,
      },
    });
  } catch (error: any) {
    console.error('Top query categories error:', error);
    res.status(500).json({ error: 'Failed to fetch top query categories' });
  }
});

export default router;
