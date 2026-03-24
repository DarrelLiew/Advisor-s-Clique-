import type OpenAI from 'openai';

export type ChatMode = 'client' | 'learner' | 'agent';

export interface RetrievedChunk {
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  similarity: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface CostEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface CostBreakdown {
  entries: CostEntry[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface AgentCallbacks {
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onGenerating?: () => void;
}

export type AgentStopReason =
  | 'completed'        // LLM returned a text answer naturally
  | 'max_iterations'   // Hit AGENT_MAX_ITERATIONS limit
  | 'timeout'          // Hit AGENT_TIMEOUT_MS limit
  | 'empty_response';  // LLM returned neither tool calls nor text

export interface AgentResult {
  answer: string;
  chunks: RetrievedChunk[];
  iterations: number;
  toolCalls: ToolCallRecord[];
  cost: CostBreakdown;
  stopReason: AgentStopReason;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  allChunks: RetrievedChunk[],
) => Promise<string>;

export type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
