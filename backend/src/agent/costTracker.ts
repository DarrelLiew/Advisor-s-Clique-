import * as fs from 'fs';
import * as path from 'path';
import type { CostEntry, CostBreakdown } from './types';

// OpenAI pricing per 1M tokens (as of March 2026)
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
};

function lookupPricing(model: string): { input: number; output: number } {
  // Exact match first, then prefix match for versioned model names like "gpt-4o-mini-2024-07-18"
  if (PRICING[model]) return PRICING[model];
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  // Default to gpt-4o-mini pricing if unknown
  return PRICING['gpt-4o-mini'];
}

function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = lookupPricing(model);
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

const LOG_FILE = path.resolve(__dirname, '..', '..', '..', '..', 'logs', 'cost-log.txt');

function ensureLogFile(): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(
      LOG_FILE,
      'timestamp\tuser_id\tmode\tquery\tinput_tokens\toutput_tokens\ttotal_tokens\tcost_usd\tmodels\titerations\n',
      'utf-8',
    );
  }
}

export class CostTracker {
  private entries: CostEntry[] = [];

  record(model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): void {
    if (!usage) return;
    this.entries.push({
      model,
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    });
  }

  getTotals(): CostBreakdown {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const e of this.entries) {
      totalInput += e.input_tokens;
      totalOutput += e.output_tokens;
      totalCost += calculateCostUsd(e.model, e.input_tokens, e.output_tokens);
    }

    return {
      entries: this.entries,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_tokens: totalInput + totalOutput,
      cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000, // 6 decimal precision
    };
  }

  /**
   * Append a line to the cost log file. Fire-and-forget — errors are logged to console.
   */
  writeToLog(params: {
    userId: string;
    mode: string;
    query: string;
    iterations?: number;
  }): void {
    try {
      ensureLogFile();
      const totals = this.getTotals();
      const models = [...new Set(this.entries.map((e) => e.model))].join(',');
      const queryPreview = params.query.replace(/[\t\n\r]/g, ' ').slice(0, 120);
      const line = [
        new Date().toISOString(),
        params.userId,
        params.mode,
        queryPreview,
        totals.total_input_tokens,
        totals.total_output_tokens,
        totals.total_tokens,
        totals.cost_usd.toFixed(6),
        models,
        params.iterations ?? 0,
      ].join('\t');
      fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
    } catch (err) {
      console.error('[CostTracker] Failed to write cost log:', err);
    }
  }
}
