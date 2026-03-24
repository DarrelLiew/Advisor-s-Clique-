import { evaluate } from 'mathjs';
import type { ToolExecutor } from '../types';

/**
 * Safe math expression evaluator. Uses mathjs — no eval().
 * Only arithmetic operations are allowed.
 */
export const executeTool: ToolExecutor = async (args) => {
  const expression = String(args.expression ?? '');
  const description = args.description ? String(args.description) : undefined;

  if (!expression.trim()) {
    return 'Error: No expression provided.';
  }

  // Block anything that looks like code injection
  if (/[;{}[\]\\]|import|require|function|=>|const |let |var /.test(expression)) {
    return 'Error: Expression contains disallowed characters. Only arithmetic operations (+, -, *, /, ^, parentheses) are supported.';
  }

  try {
    const result = evaluate(expression);
    const numericResult = typeof result === 'number'
      ? result
      : Number(result);

    if (!Number.isFinite(numericResult)) {
      return `Error: Result is not a finite number (got ${result}).`;
    }

    const formatted = Number.isInteger(numericResult)
      ? numericResult.toString()
      : numericResult.toFixed(2);

    return description
      ? `${description}: ${formatted}`
      : `Result: ${formatted}`;
  } catch (err: any) {
    return `Error evaluating expression: ${err.message}`;
  }
};
