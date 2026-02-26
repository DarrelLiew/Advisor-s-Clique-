import { supabase } from '../lib/supabase';

interface AnalyticsLogParams {
  userId: string;
  queryText: string;
  responseTimeMs: number;
  metadata?: Record<string, unknown>;
}

function isMissingMetadataColumnError(error: { message?: string } | null): boolean {
  const message = (error?.message || '').toLowerCase();
  return (
    message.includes('metadata')
    && (
      message.includes('column')
      || message.includes('schema cache')
      || message.includes('does not exist')
    )
  );
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
      metadata: metadata ?? {},
    })
    .then(({ error }) => {
      if (!error) return;

      // Backward compatibility for environments where question_analytics.metadata
      // has not been added yet.
      if (isMissingMetadataColumnError(error)) {
        return supabase
          .from('question_analytics')
          .insert({
            user_id: userId,
            query_text: queryText,
            response_time_ms: responseTimeMs,
          })
          .then(({ error: fallbackError }) => {
            if (fallbackError) {
              console.error('[analyticsLog] Failed to save analytics:', fallbackError.message);
            }
          });
      }

      console.error('[analyticsLog] Failed to save analytics:', error.message);
    });
}
