import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { supabase } from '../lib/supabase';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth';
import { createAuditLog } from '../utils/auditLog';

const router = Router();

// Link Telegram account
router.post('/link-telegram', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { token } = req.body;
    const userId = req.user!.id;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      telegram_id: number;
      telegram_username?: string;
    };

    // Check token in database
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const { data: linkToken, error: tokenError } = await supabase
      .from('telegram_link_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .single();

    if (tokenError || !linkToken) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    if (linkToken.used) {
      return res.status(400).json({ error: 'Token already used' });
    }

    if (new Date(linkToken.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    // Check if telegram_id already linked
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('telegram_id', decoded.telegram_id)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Telegram account already linked to another user' });
    }

    // Update profile with telegram_id
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ telegram_id: decoded.telegram_id })
      .eq('id', userId);

    if (updateError) throw updateError;

    // Mark token as used
    await supabase
      .from('telegram_link_tokens')
      .update({ used: true, used_by: userId, used_at: new Date().toISOString() })
      .eq('id', linkToken.id);

    await createAuditLog({
      userId,
      action: 'telegram_linked',
      metadata: { telegram_id: decoded.telegram_id, telegram_username: decoded.telegram_username },
    });

    res.json({ success: true, message: 'Telegram account linked successfully' });
  } catch (error: any) {
    console.error('Link Telegram error:', error);
    res.status(500).json({ error: error.message || 'Failed to link Telegram account' });
  }
});

// Logout
router.post('/logout', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.substring(7);

    if (token) {
      await supabase.auth.admin.signOut(token);
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error: any) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
