import OpenAI from 'openai';
import { ragConfig } from '../services/ragConfig';
import { buildAgentSystemPrompt, getToolDefinitions } from './prompts';
import { loadConversationHistory } from './memory';
import { CostTracker } from './costTracker';
import { createSearchDocumentsTool } from './tools/searchDocuments';
import { executeTool as executeCalculate } from './tools/calculate';
import { executeTool as executeGetPages } from './tools/getDocumentPages';
import type {
  AgentResult,
  AgentCallbacks,
  RetrievedChunk,
  ToolCallRecord,
  ToolExecutor,
  OpenAIMessage,
} from './types';

/**
 * Run the agent loop: plan → act → observe → repeat.
 * The agent calls tools iteratively until it has enough information to answer.
 */
export async function runAgent(
  openai: OpenAI,
  query: string,
  sessionId: string,
  callbacks?: AgentCallbacks,
): Promise<AgentResult> {
  const systemPrompt = buildAgentSystemPrompt();
  const history = await loadConversationHistory(sessionId);
  const tools = getToolDefinitions();
  const costTracker = new CostTracker();

  const messages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: query },
  ];

  // Build tool executor map
  const searchTool = createSearchDocumentsTool(openai);
  const toolExecutors: Record<string, ToolExecutor> = {
    search_documents: searchTool,
    get_document_pages: executeGetPages,
    calculate: executeCalculate,
  };

  const allRetrievedChunks: RetrievedChunk[] = [];
  const allToolCalls: ToolCallRecord[] = [];
  let iterations = 0;
  let stopReason: import('./types').AgentStopReason = 'completed';

  const maxIterations = ragConfig.agentMaxIterations;
  const timeoutMs = ragConfig.agentTimeoutMs;
  const startTime = Date.now();

  while (iterations < maxIterations) {
    // Timeout check
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[Agent] timeout after ${iterations} iterations`);
      stopReason = 'timeout';
      break;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      temperature: 0,
      max_tokens: ragConfig.generationMaxTokensAgent,
    });

    costTracker.record(response.model, response.usage ?? undefined);
    const choice = response.choices[0];

    // If the model returned tool calls, execute them
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      // Add assistant's tool call message to the conversation
      messages.push(choice.message);

      // Execute all tool calls from this turn in parallel
      const toolResults = await Promise.all(
        choice.message.tool_calls.map(async (toolCall) => {
          const toolName = toolCall.function.name;
          let toolArgs: Record<string, unknown> = {};

          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = { raw: toolCall.function.arguments };
          }

          callbacks?.onToolCall?.(toolName, toolArgs);

          const executor = toolExecutors[toolName];
          const result = executor
            ? await executor(toolArgs, allRetrievedChunks)
            : `Error: Unknown tool "${toolName}".`;

          return { toolCall, toolName, toolArgs, result };
        }),
      );

      // Record results and add to conversation (order must match tool_calls)
      for (const { toolCall, toolName, toolArgs, result } of toolResults) {
        allToolCalls.push({ name: toolName, args: toolArgs, result });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      iterations++;
      continue;
    }

    // If the model returned text, we're done
    if (choice.message.content) {
      return {
        answer: choice.message.content,
        chunks: allRetrievedChunks,
        iterations,
        toolCalls: allToolCalls,
        cost: costTracker.getTotals(),
        stopReason: 'completed',
      };
    }

    // Edge case: no tool calls and no content — break to avoid infinite loop
    stopReason = 'empty_response';
    break;
  }

  // If we exited because iterations >= maxIterations (not timeout/empty), set reason
  if (stopReason === 'completed') {
    stopReason = 'max_iterations';
  }

  // Hit max iterations or timeout — generate a final answer with what we have
  callbacks?.onGenerating?.();

  messages.push({
    role: 'user',
    content: 'You have run out of tool calls. Please provide the best answer you can with the information you have gathered so far. If information is insufficient, say so.',
  });

  const finalResponse = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0,
    max_tokens: ragConfig.generationMaxTokensAgent,
  });

  costTracker.record(finalResponse.model, finalResponse.usage ?? undefined);

  return {
    answer: finalResponse.choices[0].message.content ?? 'Unable to generate a response.',
    chunks: allRetrievedChunks,
    iterations,
    toolCalls: allToolCalls,
    cost: costTracker.getTotals(),
    stopReason,
  };
}
