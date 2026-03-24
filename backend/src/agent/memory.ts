import { supabase } from '../lib/supabase';
import type { OpenAIMessage } from './types';

/**
 * Load conversation history from the session for agent context.
 * Returns messages in chronological order (oldest first).
 */
export async function loadConversationHistory(
  sessionId: string,
  limit: number = 6,
): Promise<OpenAIMessage[]> {
  const { data: historyRows } = await supabase
    .from('chat_messages')
    .select('query, response')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit);

  const messages: OpenAIMessage[] = [];

  if (historyRows && historyRows.length > 0) {
    for (const row of [...historyRows].reverse()) {
      messages.push({ role: 'user', content: row.query });
      messages.push({ role: 'assistant', content: row.response });
    }
  }

  return messages;
}
