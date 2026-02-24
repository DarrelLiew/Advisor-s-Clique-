import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { authenticateUser, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { processDocument } from '../services/documentProcessor';
import { createAuditLog } from '../utils/auditLog';
import { uploadLimiter, rateLimitMiddleware } from '../utils/rateLimiter';

const router = Router();

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
      .gte('created_at', thirtyDaysAgo.toISOString());

    // Get recent questions (last 10)
    const { data: recentQuestions } = await supabase
      .from('question_analytics')
      .select('query_text, created_at')
      .order('created_at', { ascending: false })
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
      .select('created_at, query_text')
      .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Group by month
    const monthlyData: Record<string, number> = {};
    data?.forEach(item => {
      const month = item.created_at.substring(0, 7); // YYYY-MM
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

export default router;
