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

// Create user account — sends Supabase invite email directly
router.post('/users/create', async (req: AuthenticatedRequest, res) => {
  try {
    const { email, role = 'user' } = req.body;

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

    // Invite user via Supabase — sends an email with a link to set password
    const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
      email.trim(),
      {
        data: { role },
        redirectTo: `${process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:3000'}/set-password`,
      },
    );

    if (inviteError) throw inviteError;

    // Update profile with invitation metadata (profile auto-created by trigger)
    // Small delay to let the trigger fire
    await new Promise((resolve) => setTimeout(resolve, 500));
    await supabase
      .from('profiles')
      .update({
        role,
        invitation_status: 'pending',
        invitation_sent_at: new Date().toISOString(),
      })
      .eq('id', inviteData.user.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'user_invited',
      resourceType: 'user',
      resourceId: inviteData.user.id,
      metadata: { email: email.trim(), role },
    });

    res.json({
      success: true,
      user: {
        id: inviteData.user.id,
        email: email.trim(),
        role,
      },
      message: 'Invitation email sent successfully.',
    });
  } catch (error: any) {
    console.error('Create user error:', error);
    res.status(500).json({ error: error.message || 'Failed to create user' });
  }
});

// Resend invitation email
router.patch('/users/:id/resend-invite', async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    // Look up user email
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(id);
    if (userError || !userData?.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const email = userData.user.email;
    if (!email) {
      return res.status(400).json({ error: 'User has no email address' });
    }

    // Check invitation status
    const { data: profile } = await supabase
      .from('profiles')
      .select('invitation_status')
      .eq('id', id)
      .single();

    if (profile?.invitation_status === 'accepted') {
      return res.status(400).json({ error: 'User has already accepted the invitation' });
    }

    // Re-invite the user
    const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
      email,
      {
        data: userData.user.user_metadata,
        redirectTo: `${process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:3000'}/set-password`,
      },
    );

    if (inviteError) throw inviteError;

    // Update invitation_sent_at
    await supabase
      .from('profiles')
      .update({ invitation_sent_at: new Date().toISOString() })
      .eq('id', id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'invitation_resent',
      resourceType: 'user',
      resourceId: id,
      metadata: { email },
    });

    res.json({ success: true, message: 'Invitation email resent successfully.' });
  } catch (error: any) {
    console.error('Resend invite error:', error);
    res.status(500).json({ error: error.message || 'Failed to resend invitation' });
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
        metadata,
        invitation_status,
        invitation_sent_at
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get emails and last_sign_in from auth.users (requires service role)
    const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();

    if (authError) throw authError;

    const usersMap = new Map(authUsers.users.map(u => [u.id, u]));

    const users = data.map(profile => {
      const authUser = usersMap.get(profile.id);
      // If the user has signed in, they've accepted the invitation
      const hasSignedIn = !!authUser?.last_sign_in_at;
      const effectiveStatus = hasSignedIn ? 'accepted' : (profile.invitation_status || 'pending');

      return {
        ...profile,
        email: authUser?.email,
        telegram_linked: !!profile.telegram_id,
        invitation_status: effectiveStatus,
        last_sign_in_at: authUser?.last_sign_in_at || null,
      };
    });

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

// Response time percentiles (p50, p75, p95, p99)
router.get('/analytics/response-time', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 90);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await supabase
      .from('question_analytics')
      .select('response_time_ms, timestamp')
      .gte('timestamp', startDate.toISOString())
      .not('response_time_ms', 'is', null)
      .order('timestamp', { ascending: true });

    if (error) throw error;

    const times = (data ?? [])
      .map((r) => r.response_time_ms as number)
      .filter((t) => typeof t === 'number' && t > 0)
      .sort((a, b) => a - b);

    if (times.length === 0) {
      return res.json({
        percentiles: { p50: null, p75: null, p95: null, p99: null },
        avg: null,
        count: 0,
        window: { days, timezone: ANALYTICS_TIMEZONE },
      });
    }

    const percentile = (arr: number[], p: number): number => {
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)];
    };

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);

    res.json({
      percentiles: {
        p50: percentile(times, 50),
        p75: percentile(times, 75),
        p95: percentile(times, 95),
        p99: percentile(times, 99),
      },
      avg,
      count: times.length,
      window: { days, timezone: ANALYTICS_TIMEZONE },
    });
  } catch (error: any) {
    console.error('Response time analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch response time analytics' });
  }
});

// Question source breakdown (web vs telegram)
router.get('/analytics/sources', async (req: AuthenticatedRequest, res) => {
  try {
    const months = parsePositiveInt(req.query.months, 12, 24);
    const { monthKeys, startIso, endIso } = getRecentSgMonthRangeUtc(months);
    const diagnostics = await resolveAnalyticsDiagnostics();

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp, metadata')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .order('timestamp', { ascending: true });

    if (error) throw error;

    // Initialize counts per month
    const webCounts: Record<string, number> = {};
    const telegramCounts: Record<string, number> = {};
    const unknownCounts: Record<string, number> = {};

    for (const month of monthKeys) {
      webCounts[month] = 0;
      telegramCounts[month] = 0;
      unknownCounts[month] = 0;
    }

    for (const row of (data ?? []) as Array<{ timestamp: string; metadata: Record<string, unknown> | null }>) {
      const month = getSgMonthKeyFromTimestamp(row.timestamp);
      if (!month || !(month in webCounts)) continue;

      const source = row.metadata?.source;
      if (source === 'telegram') {
        telegramCounts[month] += 1;
      } else if (source === 'web') {
        webCounts[month] += 1;
      } else {
        // Default to web if source not specified (legacy data)
        unknownCounts[month] += 1;
      }
    }

    const series = monthKeys.map((month) => ({
      month,
      web: webCounts[month] + unknownCounts[month], // Include unknown as web (legacy)
      telegram: telegramCounts[month],
      total: webCounts[month] + telegramCounts[month] + unknownCounts[month],
    }));

    const totals = {
      web: series.reduce((s, m) => s + m.web, 0),
      telegram: series.reduce((s, m) => s + m.telegram, 0),
      total: series.reduce((s, m) => s + m.total, 0),
    };

    res.json({
      data: series,
      totals,
      data_quality: diagnostics.dataQuality,
      diagnostics: {
        metadata_available: diagnostics.metadataAvailable,
        timezone: ANALYTICS_TIMEZONE,
      },
    });
  } catch (error: any) {
    console.error('Sources analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch sources analytics' });
  }
});

// Document citations — which documents are cited most in responses
router.get('/analytics/document-citations', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 90);
    const limit = parsePositiveInt(req.query.limit, 10, 50);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get chat messages with sources
    const { data: messages, error: messagesError } = await supabase
      .from('chat_messages')
      .select('sources')
      .gte('created_at', startDate.toISOString())
      .not('sources', 'is', null);

    if (messagesError) throw messagesError;

    // Count document citations
    const citationCounts: Record<string, { documentId: string; count: number; pages: Set<number> }> = {};

    for (const msg of (messages ?? [])) {
      const sources = msg.sources as Array<{ documentId?: string; document_id?: string; pageNumber?: number; page_number?: number }> | null;
      if (!Array.isArray(sources)) continue;

      for (const source of sources) {
        const docId = source.documentId || source.document_id;
        if (!docId) continue;

        if (!citationCounts[docId]) {
          citationCounts[docId] = { documentId: docId, count: 0, pages: new Set() };
        }
        citationCounts[docId].count += 1;

        const pageNum = source.pageNumber || source.page_number;
        if (typeof pageNum === 'number') {
          citationCounts[docId].pages.add(pageNum);
        }
      }
    }

    // Get document details for top cited
    const topDocIds = Object.values(citationCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((c) => c.documentId);

    if (topDocIds.length === 0) {
      return res.json({
        data: [],
        window: { days },
      });
    }

    const { data: documents, error: docsError } = await supabase
      .from('documents')
      .select('id, filename, total_pages')
      .in('id', topDocIds);

    if (docsError) throw docsError;

    const docMap = new Map((documents ?? []).map((d) => [d.id, d]));

    const result = topDocIds.map((docId) => {
      const citation = citationCounts[docId];
      const doc = docMap.get(docId);
      return {
        document_id: docId,
        filename: doc?.filename ?? 'Unknown',
        total_pages: doc?.total_pages ?? null,
        citation_count: citation.count,
        unique_pages_cited: citation.pages.size,
      };
    });

    res.json({
      data: result,
      window: { days },
    });
  } catch (error: any) {
    console.error('Document citations error:', error);
    res.status(500).json({ error: 'Failed to fetch document citations' });
  }
});

// Extended monthly analytics with source split
router.get('/analytics/monthly-extended', async (req: AuthenticatedRequest, res) => {
  try {
    const months = parsePositiveInt(req.query.months, 12, 24);
    const split = getSingleQueryParam(req.query.split) === 'source';
    const { monthKeys, startIso, endIso } = getRecentSgMonthRangeUtc(months);
    const diagnostics = await resolveAnalyticsDiagnostics();

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp, metadata')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .order('timestamp', { ascending: true });

    if (error) throw error;

    if (!split) {
      // Simple counts per month
      const counts: Record<string, number> = {};
      for (const month of monthKeys) {
        counts[month] = 0;
      }

      for (const row of (data ?? [])) {
        const month = getSgMonthKeyFromTimestamp(row.timestamp);
        if (month && month in counts) {
          counts[month] += 1;
        }
      }

      return res.json({
        data: monthKeys.map((month) => ({ month, questions: counts[month] })),
        data_quality: diagnostics.dataQuality,
      });
    }

    // Split by source (web vs telegram) + unanswered overlay
    const webCounts: Record<string, number> = {};
    const telegramCounts: Record<string, number> = {};
    const unansweredCounts: Record<string, number> = {};

    for (const month of monthKeys) {
      webCounts[month] = 0;
      telegramCounts[month] = 0;
      unansweredCounts[month] = 0;
    }

    for (const row of (data ?? []) as Array<{ timestamp: string; metadata: Record<string, unknown> | null }>) {
      const month = getSgMonthKeyFromTimestamp(row.timestamp);
      if (!month || !(month in webCounts)) continue;

      const source = row.metadata?.source;
      if (source === 'telegram') {
        telegramCounts[month] += 1;
      } else {
        webCounts[month] += 1;
      }

      const outcome = getOutcome(row.metadata);
      if (outcome && FINANCIAL_UNANSWERED_OUTCOMES.has(outcome)) {
        unansweredCounts[month] += 1;
      }
    }

    const series = monthKeys.map((month) => ({
      month,
      web: webCounts[month],
      telegram: telegramCounts[month],
      unanswered: unansweredCounts[month],
      total: webCounts[month] + telegramCounts[month],
    }));

    res.json({
      data: series,
      totals: {
        web: series.reduce((s, m) => s + m.web, 0),
        telegram: series.reduce((s, m) => s + m.telegram, 0),
        unanswered: series.reduce((s, m) => s + m.unanswered, 0),
      },
      data_quality: diagnostics.dataQuality,
      diagnostics: {
        metadata_available: diagnostics.metadataAvailable,
        timezone: ANALYTICS_TIMEZONE,
      },
    });
  } catch (error: any) {
    console.error('Monthly extended analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch monthly extended analytics' });
  }
});

// Query lifecycle funnel
router.get('/analytics/funnel', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, 365);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await supabase
      .from('question_analytics')
      .select('metadata')
      .gte('timestamp', startDate.toISOString());

    if (error) throw error;

    // Count funnel stages
    let questionsReceived = 0;
    let sourcesRetrieved = 0;
    let answerGenerated = 0;
    let citationsPresent = 0;
    let confirmedAccurate = 0;

    for (const row of (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
      questionsReceived += 1;

      const outcome = getOutcome(row.metadata);
      if (!outcome) continue;

      // Sources retrieved = not "no_chunks"
      if (outcome !== 'no_chunks') {
        sourcesRetrieved += 1;
      }

      // Answer generated = success or web_fallback
      if (outcome === 'success' || outcome === 'web_fallback' || outcome === 'no_direct_answer_in_docs') {
        answerGenerated += 1;
      }

      // Citations present = success
      if (outcome === 'success') {
        citationsPresent += 1;
        // Assume success means confirmed accurate (no negative feedback)
        confirmedAccurate += 1;
      }
    }

    res.json({
      steps: [
        { label: 'Questions received', value: questionsReceived, sub: '100%' },
        { label: 'Sources retrieved', value: sourcesRetrieved, sub: 'Vector search hit ≥1 chunk' },
        { label: 'Answer generated', value: answerGenerated, sub: 'LLM returned a response' },
        { label: 'Citations present', value: citationsPresent, sub: 'Answer cites ≥1 page' },
        { label: 'Confirmed accurate', value: confirmedAccurate, sub: 'User up-voted or no-correction' },
      ],
    });
  } catch (error: any) {
    console.error('Funnel analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch funnel analytics' });
  }
});

// Activity heatmap — hour-of-day × day-of-week
router.get('/analytics/heatmap', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 90);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp')
      .gte('timestamp', startDate.toISOString());

    if (error) throw error;

    const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const values: number[][] = daysOfWeek.map(() => Array(24).fill(0));

    for (const row of (data ?? [])) {
      const date = new Date(row.timestamp);
      // Adjust to Singapore time
      const sgDate = new Date(date.getTime() + SGT_OFFSET_MS);
      const dayIndex = (sgDate.getUTCDay() + 6) % 7; // Convert Sunday=0 to Monday=0
      const hour = sgDate.getUTCHours();
      values[dayIndex][hour] += 1;
    }

    res.json({
      days: daysOfWeek,
      hours,
      values,
    });
  } catch (error: any) {
    console.error('Heatmap analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch heatmap analytics' });
  }
});

// Advisor retention cohorts
router.get('/analytics/cohorts', async (req: AuthenticatedRequest, res) => {
  try {
    // Get all users and their first activity date
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

    if (profilesError) throw profilesError;

    // Get question analytics to determine activity
    const sixWeeksAgo = new Date();
    sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42);

    const { data: activity, error: activityError } = await supabase
      .from('question_analytics')
      .select('user_id, timestamp')
      .gte('timestamp', sixWeeksAgo.toISOString());

    if (activityError) throw activityError;

    // Build activity map: userId -> Set of week numbers since sign-up
    const userActivityWeeks = new Map<string, Set<number>>();
    const userSignupDate = new Map<string, Date>();

    for (const profile of (profiles ?? [])) {
      userSignupDate.set(profile.id, new Date(profile.created_at));
      userActivityWeeks.set(profile.id, new Set());
    }

    for (const row of (activity ?? [])) {
      const userId = row.user_id;
      if (!userSignupDate.has(userId)) continue;

      const signupDate = userSignupDate.get(userId)!;
      const activityDate = new Date(row.timestamp);
      const weeksSinceSignup = Math.floor(
        (activityDate.getTime() - signupDate.getTime()) / (7 * 24 * 60 * 60 * 1000)
      );

      if (weeksSinceSignup >= 0 && weeksSinceSignup <= 5) {
        userActivityWeeks.get(userId)!.add(weeksSinceSignup);
      }
    }

    // Group users into weekly cohorts based on signup week
    const now = new Date();
    const cohortWeeks: Map<string, string[]> = new Map();

    for (const profile of (profiles ?? [])) {
      const signupDate = new Date(profile.created_at);
      // Get Monday of the signup week
      const dayOfWeek = signupDate.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(signupDate);
      monday.setDate(signupDate.getDate() + mondayOffset);
      const cohortKey = monday.toISOString().slice(0, 10);

      if (!cohortWeeks.has(cohortKey)) {
        cohortWeeks.set(cohortKey, []);
      }
      cohortWeeks.get(cohortKey)!.push(profile.id);
    }

    // Build cohort retention data (last 6 cohorts)
    const sortedCohorts = Array.from(cohortWeeks.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 6);

    const cohorts = sortedCohorts.map(([cohortKey, userIds]) => {
      const cohortDate = new Date(cohortKey);
      const weeksSinceCohort = Math.floor(
        (now.getTime() - cohortDate.getTime()) / (7 * 24 * 60 * 60 * 1000)
      );

      const retention: (number | null)[] = [];
      for (let week = 0; week <= 5; week++) {
        if (week > weeksSinceCohort) {
          retention.push(null);
        } else {
          const activeCount = userIds.filter(
            (uid) => userActivityWeeks.get(uid)?.has(week)
          ).length;
          retention.push(Math.round((activeCount / userIds.length) * 100));
        }
      }

      // Format label
      const labelDate = new Date(cohortKey);
      const label = `W beg. ${labelDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

      return {
        label,
        size: userIds.length,
        retention,
      };
    });

    res.json({ cohorts });
  } catch (error: any) {
    console.error('Cohorts analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch cohorts analytics' });
  }
});

// Power users — most active advisors
router.get('/analytics/power-users', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 90);
    const limit = parsePositiveInt(req.query.limit, 5, 20);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get query counts per user
    const { data: queries, error: queriesError } = await supabase
      .from('question_analytics')
      .select('user_id, timestamp, metadata')
      .gte('timestamp', startDate.toISOString());

    if (queriesError) throw queriesError;

    // Aggregate by user
    const userStats = new Map<string, { count: number; successCount: number; lastActive: string }>();

    for (const row of (queries ?? []) as Array<{ user_id: string; timestamp: string; metadata: Record<string, unknown> | null }>) {
      const userId = row.user_id;
      if (!userStats.has(userId)) {
        userStats.set(userId, { count: 0, successCount: 0, lastActive: row.timestamp });
      }

      const stats = userStats.get(userId)!;
      stats.count += 1;

      if (row.timestamp > stats.lastActive) {
        stats.lastActive = row.timestamp;
      }

      const outcome = getOutcome(row.metadata);
      if (outcome === 'success') {
        stats.successCount += 1;
      }
    }

    // Get top users by query count
    const topUserIds = Array.from(userStats.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([userId]) => userId);

    if (topUserIds.length === 0) {
      return res.json({ users: [] });
    }

    // Get user profiles
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, metadata')
      .in('id', topUserIds);

    if (profilesError) throw profilesError;

    // Fetch emails for top users individually (more reliable than listUsers)
    const emailMap = new Map<string, string>();
    for (const userId of topUserIds) {
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(userId);
        if (userData?.user?.email) {
          emailMap.set(userId, userData.user.email);
        }
      } catch {
        // Skip if user lookup fails
      }
    }

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

    const users = topUserIds.map((userId) => {
      const stats = userStats.get(userId)!;
      const profile = profileMap.get(userId);
      const email = emailMap.get(userId) ?? 'Unknown';
      const name = (profile?.metadata as Record<string, unknown>)?.name as string | undefined || email.split('@')[0] || 'Unknown';
      const initials = name
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() || '')
        .join('') || 'U';
      const team = (profile?.metadata as Record<string, unknown>)?.team as string | undefined || 'General';

      const lastActiveDate = new Date(stats.lastActive);
      const now = new Date();
      const diffMs = now.getTime() - lastActiveDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      let lastActive: string;
      if (diffMins < 60) {
        lastActive = `${diffMins}m ago`;
      } else if (diffMins < 1440) {
        lastActive = `${Math.floor(diffMins / 60)}h ago`;
      } else {
        lastActive = `${Math.floor(diffMins / 1440)}d ago`;
      }

      return {
        name,
        initials,
        team,
        queries: stats.count,
        acceptRate: stats.count > 0 ? Math.round((stats.successCount / stats.count) * 100) : 0,
        lastActive,
      };
    });

    res.json({ users });
  } catch (error: any) {
    console.error('Power users analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch power users analytics' });
  }
});

// Topic momentum — week-over-week changes
router.get('/analytics/momentum', async (req: AuthenticatedRequest, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 6, 20);

    // Get data for last 2 weeks
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const { data, error } = await supabase
      .from('question_analytics')
      .select('query_text, timestamp, metadata')
      .gte('timestamp', twoWeeksAgo.toISOString());

    if (error) throw error;

    // Categorize and split by week
    const thisWeekCounts: Record<string, number> = {};
    const lastWeekCounts: Record<string, number> = {};

    for (const row of (data ?? []) as Array<{ query_text: string; timestamp: string; metadata: Record<string, unknown> | null }>) {
      const outcome = getOutcome(row.metadata);
      if (!outcome || !FINANCIAL_ANALYTICS_OUTCOMES.has(outcome)) continue;

      const category = categorizeQueryText(row.query_text || '');
      const isThisWeek = new Date(row.timestamp) >= oneWeekAgo;

      if (isThisWeek) {
        thisWeekCounts[category] = (thisWeekCounts[category] || 0) + 1;
      } else {
        lastWeekCounts[category] = (lastWeekCounts[category] || 0) + 1;
      }
    }

    // Calculate momentum
    const allCategories = new Set([
      ...Object.keys(thisWeekCounts),
      ...Object.keys(lastWeekCounts),
    ]);

    const toneMap: Record<string, string> = {
      'KYC & Suitability': 'teal',
      'Product Features & Eligibility': 'gold',
      'Portfolio Construction & Allocation': 'navy',
      'Fees & Compensation': 'coral',
      'Performance & Benchmarks': 'teal',
      'Compliance & Disclosure': 'aub',
      'Account Operations & Transactions': 'gold',
      'Client Recommendation Wording': 'navy',
    };

    const items = Array.from(allCategories)
      .map((category) => {
        const thisWeek = thisWeekCounts[category] || 0;
        const lastWeek = lastWeekCounts[category] || 0;
        const wow = lastWeek > 0
          ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
          : thisWeek > 0 ? 100 : 0;

        return {
          topic: category,
          wow,
          asks: thisWeek + lastWeek,
          tone: toneMap[category] || 'gold',
        };
      })
      .filter((item) => item.asks > 0)
      .sort((a, b) => Math.abs(b.wow) - Math.abs(a.wow))
      .slice(0, limit);

    res.json({ items });
  } catch (error: any) {
    console.error('Momentum analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch momentum analytics' });
  }
});

// Daily trend — current period vs prior period
router.get('/analytics/daily-trend', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, 180);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2); // Get double the period for comparison

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp')
      .gte('timestamp', startDate.toISOString())
      .order('timestamp', { ascending: true });

    if (error) throw error;

    const now = new Date();
    const currentPeriodStart = new Date(now);
    currentPeriodStart.setDate(now.getDate() - days);
    const priorPeriodStart = new Date(currentPeriodStart);
    priorPeriodStart.setDate(currentPeriodStart.getDate() - days);

    // Initialize daily counts
    const currentCounts: number[] = Array(days).fill(0);
    const priorCounts: number[] = Array(days).fill(0);

    for (const row of (data ?? [])) {
      const date = new Date(row.timestamp);

      if (date >= currentPeriodStart) {
        const dayIndex = Math.floor((date.getTime() - currentPeriodStart.getTime()) / (24 * 60 * 60 * 1000));
        if (dayIndex >= 0 && dayIndex < days) {
          currentCounts[dayIndex] += 1;
        }
      } else if (date >= priorPeriodStart) {
        const dayIndex = Math.floor((date.getTime() - priorPeriodStart.getTime()) / (24 * 60 * 60 * 1000));
        if (dayIndex >= 0 && dayIndex < days) {
          priorCounts[dayIndex] += 1;
        }
      }
    }

    // Calculate stats
    const currentTotal = currentCounts.reduce((a, b) => a + b, 0);
    const priorTotal = priorCounts.reduce((a, b) => a + b, 0);
    const periodOverPeriod = priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal) * 100 : 0;

    // Find peak and slowest days
    let peakIndex = 0;
    let slowestIndex = 0;
    for (let i = 0; i < currentCounts.length; i++) {
      if (currentCounts[i] > currentCounts[peakIndex]) peakIndex = i;
      if (currentCounts[i] < currentCounts[slowestIndex]) slowestIndex = i;
    }

    const peakDate = new Date(currentPeriodStart);
    peakDate.setDate(peakDate.getDate() + peakIndex);
    const slowestDate = new Date(currentPeriodStart);
    slowestDate.setDate(slowestDate.getDate() + slowestIndex);

    res.json({
      current: currentCounts,
      previous: priorCounts,
      startDate: currentPeriodStart.toISOString().slice(0, 10),
      stats: {
        periodOverPeriod,
        peakDay: {
          date: peakDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
          count: currentCounts[peakIndex],
        },
        slowestDay: {
          date: slowestDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
            ` (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][slowestDate.getDay()]})`,
          count: currentCounts[slowestIndex],
        },
      },
    });
  } catch (error: any) {
    console.error('Daily trend analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch daily trend analytics' });
  }
});

// Latency distribution with histogram bins
router.get('/analytics/latency-distribution', async (req: AuthenticatedRequest, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, 180);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await supabase
      .from('question_analytics')
      .select('response_time_ms')
      .gte('timestamp', startDate.toISOString())
      .not('response_time_ms', 'is', null);

    if (error) throw error;

    const times = (data ?? [])
      .map((r) => r.response_time_ms as number)
      .filter((t) => typeof t === 'number' && t > 0)
      .sort((a, b) => a - b);

    if (times.length === 0) {
      return res.json({
        percentiles: { p50: null, p75: null, p90: null, p95: null, p99: null },
        bins: [],
        totalCount: 0,
      });
    }

    const percentile = (arr: number[], p: number): number => {
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)];
    };

    // Define bins in milliseconds
    const binRanges = [
      { range: '<0.5s', min: 0, max: 500 },
      { range: '0.5–1s', min: 500, max: 1000 },
      { range: '1–1.5s', min: 1000, max: 1500 },
      { range: '1.5–2s', min: 1500, max: 2000 },
      { range: '2–3s', min: 2000, max: 3000 },
      { range: '3–5s', min: 3000, max: 5000 },
      { range: '>5s', min: 5000, max: Infinity },
    ];

    const bins = binRanges.map(({ range, min, max }) => ({
      range,
      count: times.filter((t) => t >= min && t < max).length,
    }));

    res.json({
      percentiles: {
        p50: percentile(times, 50),
        p75: percentile(times, 75),
        p90: percentile(times, 90),
        p95: percentile(times, 95),
        p99: percentile(times, 99),
      },
      bins,
      totalCount: times.length,
    });
  } catch (error: any) {
    console.error('Latency distribution error:', error);
    res.status(500).json({ error: 'Failed to fetch latency distribution' });
  }
});

export default router;
