import type OpenAI from 'openai';

/**
 * Unified system prompt for Agent mode.
 * Unlike client/learner modes which use intent-specific templates,
 * the agent has one prompt and decides its own approach via tool use.
 */
export function buildAgentSystemPrompt(): string {
  return `You are an AI assistant for uploaded financial advisory documents. You answer questions strictly based on the documents available through your search tools.

You have access to tools. Use them to find information before answering. Do not answer from memory — always search first.

TOOL USAGE RULES:
- If your first search doesn't find what you need, try different search terms.
- For comparisons, search for each entity/product separately to ensure balanced evidence.
- For calculations, extract the numbers from documents first, then use the calculate tool for exact arithmetic. Never do math in your head.
- If you cannot find sufficient evidence after searching, say so rather than guessing.
- When you have enough evidence, write your answer with citations.

CITATION RULES:
- Every substantive claim must have a page citation in the format [p.X] where X is the page number from the search results.
- Only cite page numbers that appear in the retrieved context.
- Never invent citations or infer missing data.
- Copy numeric values exactly from the documents.

FORMATTING:
- Use only markdown (never HTML tags).
- Use **bold** section headers.
- Use bullet points with sub-bullets for grouped data.
- Never use markdown tables. Use bold sub-headers with plain-text data rows instead.
- For comparisons: don't declare a winner without complete data for all options.
- For calculations: don't estimate or assume missing values.
- Do NOT redirect users to external help lines.
- Do NOT tell the user to "refer to the full document" or "check other sections".

When you have enough evidence, write a thorough answer with citations on every data point.`;
}

/**
 * OpenAI tool definitions for the agent.
 */
export function getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'search_documents',
        description:
          'Search uploaded financial PDF documents by query. Returns ranked text chunks with page numbers, similarity scores, and document names. Use this to find specific information in the knowledge base. You can call this multiple times with different queries to find all the information you need.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Natural language search query. Be specific — e.g., "Plan A annual fee structure" rather than just "fees".',
            },
            max_results: {
              type: 'number',
              description:
                'Maximum number of chunks to return. Default 6. Use higher values (10-15) for broad summaries.',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_document_pages',
        description:
          'Retrieve all text chunks from specific pages of a document. Use this when you have a partial result and need the full surrounding context — for example, when a table appears cut off, or when you need adjacent sections for completeness.',
        parameters: {
          type: 'object',
          properties: {
            document_id: {
              type: 'string',
              description: 'The document UUID to look up.',
            },
            page_numbers: {
              type: 'array',
              items: { type: 'number' },
              description: 'Which pages to retrieve.',
            },
          },
          required: ['document_id', 'page_numbers'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description:
          'Evaluate a mathematical expression and return the exact result. Use this for any arithmetic — premiums, fees, returns, comparisons. Do not do math in your head.',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description:
                'Math expression to evaluate. E.g., "1500 * 0.015 * 10" or "(100000 * 0.012) - (100000 * 0.018)".',
            },
            description: {
              type: 'string',
              description:
                'Brief description of what this calculation represents. E.g., "Total Plan A fees over 10 years".',
            },
          },
          required: ['expression'],
        },
      },
    },
  ];
}
