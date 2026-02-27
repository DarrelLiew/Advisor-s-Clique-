import { supabase } from '../lib/supabase';

interface AnalyticsLogParams {
  userId: string;
  queryText: string;
  responseTimeMs: number;
  metadata?: Record<string, unknown>;
}

type AnalyticsInsertStatus = 'metadata_insert_ok' | 'metadata_missing_fallback_used' | 'insert_failed';

interface AnalyticsInsertTelemetry {
  metadata_insert_ok: number;
  metadata_missing_fallback_used: number;
  insert_failed: number;
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

const analyticsInsertTelemetry: AnalyticsInsertTelemetry = {
  metadata_insert_ok: 0,
  metadata_missing_fallback_used: 0,
  insert_failed: 0,
};

let metadataAvailabilityCache: { value: boolean; checkedAtMs: number } | null = null;
const METADATA_AVAILABILITY_CACHE_MS = 60_000;

function recordInsertStatus(status: AnalyticsInsertStatus): void {
  analyticsInsertTelemetry[status] += 1;
}

export function getAnalyticsInsertTelemetrySnapshot(): AnalyticsInsertTelemetry {
  return { ...analyticsInsertTelemetry };
}

export async function checkQuestionAnalyticsMetadataAvailable(forceRefresh = false): Promise<boolean> {
  const now = Date.now();
  if (!forceRefresh && metadataAvailabilityCache && (now - metadataAvailabilityCache.checkedAtMs) < METADATA_AVAILABILITY_CACHE_MS) {
    return metadataAvailabilityCache.value;
  }

  const { error } = await supabase
    .from('question_analytics')
    .select('metadata')
    .limit(1);

  if (!error) {
    metadataAvailabilityCache = { value: true, checkedAtMs: now };
    return true;
  }

  if (isMissingMetadataColumnError(error)) {
    metadataAvailabilityCache = { value: false, checkedAtMs: now };
    return false;
  }

  throw error;
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
      if (!error) {
        recordInsertStatus('metadata_insert_ok');
        metadataAvailabilityCache = { value: true, checkedAtMs: Date.now() };
        return;
      }

      // Backward compatibility for environments where question_analytics.metadata
      // has not been added yet.
      if (isMissingMetadataColumnError(error)) {
        recordInsertStatus('metadata_missing_fallback_used');
        metadataAvailabilityCache = { value: false, checkedAtMs: Date.now() };

        return supabase
          .from('question_analytics')
          .insert({
            user_id: userId,
            query_text: queryText,
            response_time_ms: responseTimeMs,
          })
          .then(({ error: fallbackError }) => {
            if (fallbackError) {
              recordInsertStatus('insert_failed');
              console.error('[analyticsLog] Failed to save analytics:', fallbackError.message);
            }
          });
      }

      recordInsertStatus('insert_failed');
      console.error('[analyticsLog] Failed to save analytics:', error.message);
    });
}
