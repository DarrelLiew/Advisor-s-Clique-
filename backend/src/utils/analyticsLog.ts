import { supabase } from '../lib/supabase';

interface AnalyticsLogParams {
  userId: string;
  queryText: string;
  responseTimeMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a row into question_analytics (fire-and-forget).
 * Returns void synchronously — the DB operation runs in the background.
 * Errors are caught and logged to console without throwing.
 */
export function logQueryAnalytics(params: AnalyticsLogParams): void {
  const { userId, queryText, responseTimeMs, metadata } = params;

  void supabase
    .from('question_analytics')
    .insert({
      user_id: userId,
      query_text: queryText,
      response_time_ms: responseTimeMs,
    })
    .then(({ error }) => {
      if (error) {
        console.error('[analyticsLog] Failed to save analytics:', error.message);
      }
    });
}
