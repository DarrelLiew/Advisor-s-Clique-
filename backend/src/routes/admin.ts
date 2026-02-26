import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { authenticateUser, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { processDocument } from '../services/documentProcessor';
import { createAuditLog } from '../utils/auditLog';
import { uploadLimiter, rateLimitMiddleware } from '../utils/rateLimiter';

const router = Router();

const UNANSWERED_OUTCOMES = new Set(['domain_gate_reject', 'web_fallback', 'no_chunks']);

const QUERY_CATEGORIES: Array<{ category: string; keywords: string[] }> = [
  { category: 'Compliance', keywords: ['compliance', 'regulation', 'regulatory', 'kyc', 'aml', 'know your client', 'ciro', 'iiroc'] },
  { category: 'Products', keywords: ['gic', 'mutual fund', 'etf', 'annuity', 'bond', 'stock', 'equity', 'fixed income'] },
  { category: 'Client Suitability', keywords: ['suitability', 'risk tolerance', 'risk profile', 'time horizon', 'client profile'] },
  { category: 'Fees', keywords: ['fee', 'fees', 'commission', 'trailer', 'expense ratio', 'mer'] },
  { category: 'Tax', keywords: ['tax', 'capital gains', 'rrsp', 'tfsa', 'taxable'] },
  { category: 'Retirement', keywords: ['retirement', 'pension', 'drawdown', 'income planning'] },
  { category: 'Insurance', keywords: ['insurance', 'life insurance', 'disability', 'critical illness'] },
  { category: 'Estate Planning', keywords: ['estate', 'will', 'trust', 'beneficiary', 'power of attorney'] },
];

function getSingleQueryParam(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function categorizeQueryText(queryText: string): string {
  const normalized = queryText.toLowerCase();
  for (const bucket of QUERY_CATEGORIES) {
    if (bucket.keywords.some((keyword) => normalized.includes(keyword))) {
      return bucket.category;
    }
  }
  return 'General';
}

function getMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function buildRecentMonthKeys(months: number): string[] {
  const now = new Date();
  const monthKeys: string[] = [];

  for (let offset = months - 1; offset >= 0; offset--) {
    const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    monthKeys.push(getMonthKey(monthDate));
  }

  return monthKeys;
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

    // Get recent questions (last 10)
    const { data: recentQuestions } = await supabase
      .from('question_analytics')
      .select('query_text, timestamp')
      .order('timestamp', { ascending: false })
      .limit(10);

    res.json({
      total_users: totalUsers,
      total_documents: totalDocuments || 0,
      documents_by_status: documentsByStatus,
      questions_last_30_days: questionsLast30Days || 0,
      recent_questions: recentQuestions || [],
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

// Unanswered / fallback analytics by month
router.get('/analytics/unanswered', async (req: AuthenticatedRequest, res) => {
  try {
    const monthsParam = getSingleQueryParam(req.query.months);
    const parsedMonths = monthsParam ? Number.parseInt(monthsParam, 10) : NaN;
    const months = Number.isInteger(parsedMonths) && parsedMonths > 0 ? Math.min(parsedMonths, 24) : 3;
    const monthKeys = buildRecentMonthKeys(months);

    const startDate = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth() - (months - 1),
      1,
    ));

    const { data, error } = await supabase
      .from('question_analytics')
      .select('timestamp, metadata')
      .gte('timestamp', startDate.toISOString())
      .order('timestamp', { ascending: true });

    if (error) {
      const message = (error.message || '').toLowerCase();
      if (message.includes('metadata') && (message.includes('column') || message.includes('does not exist'))) {
        return res.json({ data: monthKeys.map((month) => ({ month, count: 0 })) });
      }
      throw error;
    }

    const counts = monthKeys.reduce<Record<string, number>>((acc, month) => {
      acc[month] = 0;
      return acc;
    }, {});

    for (const row of (data ?? []) as Array<{ timestamp: string; metadata: Record<string, unknown> | null }>) {
      const month = row.timestamp?.slice(0, 7);
      if (!month || !(month in counts)) continue;

      const outcome = row.metadata?.outcome;
      if (typeof outcome === 'string' && UNANSWERED_OUTCOMES.has(outcome)) {
        counts[month] += 1;
      }
    }

    res.json({
      data: monthKeys.map((month) => ({
        month,
        count: counts[month] ?? 0,
      })),
    });
  } catch (error: any) {
    console.error('Unanswered analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch unanswered analytics' });
  }
});

// Top query categories (last 30 days)
router.get('/analytics/top-queries', async (req: AuthenticatedRequest, res) => {
  try {
    const limitParam = getSingleQueryParam(req.query.limit);
    const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 25) : 10;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('question_analytics')
      .select('query_text')
      .gte('timestamp', thirtyDaysAgo)
      .order('timestamp', { ascending: false })
      .limit(1000);

    if (error) throw error;

    const categoryCounts: Record<string, number> = {};
    for (const row of (data ?? []) as Array<{ query_text: string }>) {
      const category = categorizeQueryText(row.query_text || '');
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    const ranked = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([category, count]) => ({ category, count }));

    res.json({ data: ranked });
  } catch (error: any) {
    console.error('Top query categories error:', error);
    res.status(500).json({ error: 'Failed to fetch top query categories' });
  }
});

export default router;
