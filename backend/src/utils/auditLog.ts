import { supabase } from '../lib/supabase';

interface AuditLogParams {
  userId: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a row into audit_logs.
 * Errors are caught and logged to console — audit failures must not
 * interrupt or throw from the primary operation.
 */
export async function createAuditLog(params: AuditLogParams): Promise<void> {
  const { userId, action, resourceType, resourceId, metadata } = params;

  const { error } = await supabase.from('audit_logs').insert({
    user_id: userId,
    action,
    resource_type: resourceType ?? null,
    resource_id: resourceId ?? null,
    metadata: metadata ?? {},
  });

  if (error) {
    console.error(`[auditLog] Failed to write audit log (action=${action}):`, error.message);
  }
}
