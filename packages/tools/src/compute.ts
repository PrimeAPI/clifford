import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const valuesArgs = z.object({
  values: z
    .array(z.number())
    .min(1)
    .describe('Array of numbers to compute on. Must have at least 1 element.'),
});

const evalArgs = z.object({
  expression: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Mathematical expression to evaluate. Supports +, -, *, /, (), and numeric literals. Example: "(8.5 + 7.2 + 6.9) / 3"'
    ),
});

const roundArgs = z.object({
  value: z.number().describe('Number to round'),
  decimals: z
    .number()
    .int()
    .min(0)
    .max(15)
    .optional()
    .describe('Number of decimal places. Default: 2.'),
});

const percentageArgs = z.object({
  value: z.number().describe('The part value'),
  total: z.number().describe('The total/whole value'),
  decimals: z
    .number()
    .int()
    .min(0)
    .max(15)
    .optional()
    .describe('Number of decimal places. Default: 2.'),
});

// --- Safe expression evaluator (recursive descent) ---

type Token = { type: 'number'; value: number } | { type: 'op'; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ('+-*/()%'.includes(ch)) {
      // Handle unary minus: if '-' appears at start or after '(' or after an operator
      if (
        ch === '-' &&
        (tokens.length === 0 ||
          (tokens[tokens.length - 1]!.type === 'op' &&
            tokens[tokens.length - 1]!.value !== ')'))
      ) {
        // Read a negative number
        let num = '-';
        i++;
        while (i < expr.length && (/\d/.test(expr[i]!) || expr[i] === '.')) {
          num += expr[i]!;
          i++;
        }
        if (num === '-') {
          throw new Error(`Unexpected '-' at position ${i}`);
        }
        tokens.push({ type: 'number', value: parseFloat(num) });
        continue;
      }
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (/\d/.test(ch) || ch === '.') {
      let num = '';
      while (i < expr.length && (/\d/.test(expr[i]!) || expr[i] === '.')) {
        num += expr[i]!;
        i++;
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): number {
    const result = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.pos}`);
    }
    return result;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!;
      if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        this.pos++;
        const right = this.parseTerm();
        left = tok.value === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!;
      if (tok.type === 'op' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
        this.pos++;
        const right = this.parseFactor();
        if (tok.value === '*') left = left * right;
        else if (tok.value === '/') {
          if (right === 0) throw new Error('Division by zero');
          left = left / right;
        } else {
          if (right === 0) throw new Error('Modulo by zero');
          left = left % right;
        }
      } else {
        break;
      }
    }
    return left;
  }

  private parseFactor(): number {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.type === 'number') {
      this.pos++;
      return tok.value;
    }

    if (tok.type === 'op' && tok.value === '(') {
      this.pos++;
      const result = this.parseExpr();
      const closing = this.tokens[this.pos];
      if (!closing || closing.type !== 'op' || closing.value !== ')') {
        throw new Error('Expected closing parenthesis');
      }
      this.pos++;
      return result;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

function safeEval(expression: string): number {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error('Empty expression');
  const parser = new Parser(tokens);
  return parser.parse();
}

// --- Tool definition ---

export const computeTool: ToolDef = {
  name: 'compute',
  shortDescription: 'Perform arithmetic calculations',
  longDescription:
    'Deterministic math operations: average, sum, min, max, median, round, percentage, and expression evaluation. Use this instead of mental math for any numeric computation.',
  commands: [
    {
      name: 'average',
      shortDescription: 'Calculate arithmetic mean',
      longDescription: 'Calculates the arithmetic mean (average) of an array of numbers.',
      usageExample: '{"type":"tool_call","name":"compute.average","args":{"values":[8.5,7.2,6.9]}}',
      argsSchema: valuesArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { values } = valuesArgs.parse(args);
        const sum = values.reduce((a, b) => a + b, 0);
        const average = sum / values.length;
        return { success: true, average, count: values.length, sum };
      },
    },
    {
      name: 'sum',
      shortDescription: 'Calculate sum',
      longDescription: 'Calculates the sum of an array of numbers.',
      usageExample: '{"type":"tool_call","name":"compute.sum","args":{"values":[1,2,3]}}',
      argsSchema: valuesArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { values } = valuesArgs.parse(args);
        const sum = values.reduce((a, b) => a + b, 0);
        return { success: true, sum, count: values.length };
      },
    },
    {
      name: 'min',
      shortDescription: 'Find minimum value',
      longDescription: 'Finds the minimum value in an array of numbers.',
      usageExample: '{"type":"tool_call","name":"compute.min","args":{"values":[3,1,2]}}',
      argsSchema: valuesArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { values } = valuesArgs.parse(args);
        let minVal = values[0]!;
        let minIdx = 0;
        for (let i = 1; i < values.length; i++) {
          if (values[i]! < minVal) {
            minVal = values[i]!;
            minIdx = i;
          }
        }
        return { success: true, result: minVal, index: minIdx, count: values.length };
      },
    },
    {
      name: 'max',
      shortDescription: 'Find maximum value',
      longDescription: 'Finds the maximum value in an array of numbers.',
      usageExample: '{"type":"tool_call","name":"compute.max","args":{"values":[3,1,2]}}',
      argsSchema: valuesArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { values } = valuesArgs.parse(args);
        let maxVal = values[0]!;
        let maxIdx = 0;
        for (let i = 1; i < values.length; i++) {
          if (values[i]! > maxVal) {
            maxVal = values[i]!;
            maxIdx = i;
          }
        }
        return { success: true, result: maxVal, index: maxIdx, count: values.length };
      },
    },
    {
      name: 'median',
      shortDescription: 'Calculate median',
      longDescription: 'Calculates the median of an array of numbers.',
      usageExample: '{"type":"tool_call","name":"compute.median","args":{"values":[3,1,2]}}',
      argsSchema: valuesArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { values } = valuesArgs.parse(args);
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median =
          sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
        return { success: true, median, count: values.length };
      },
    },
    {
      name: 'round',
      shortDescription: 'Round a number',
      longDescription: 'Rounds a number to the specified number of decimal places.',
      usageExample: '{"type":"tool_call","name":"compute.round","args":{"value":3.14159,"decimals":2}}',
      argsSchema: roundArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { value, decimals = 2 } = roundArgs.parse(args);
        const factor = Math.pow(10, decimals);
        const result = Math.round(value * factor) / factor;
        return { success: true, result };
      },
    },
    {
      name: 'percentage',
      shortDescription: 'Calculate percentage',
      longDescription: 'Calculates what percentage value is of total.',
      usageExample:
        '{"type":"tool_call","name":"compute.percentage","args":{"value":75,"total":200}}',
      argsSchema: percentageArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { value, total, decimals = 2 } = percentageArgs.parse(args);
        if (total === 0) {
          return { success: false, error: 'Total cannot be zero' };
        }
        const percentage = (value / total) * 100;
        const factor = Math.pow(10, decimals);
        const rounded = Math.round(percentage * factor) / factor;
        return { success: true, percentage: rounded, value, total };
      },
    },
    {
      name: 'eval',
      shortDescription: 'Evaluate a math expression',
      longDescription:
        'Safely evaluates a mathematical expression string. Supports: +, -, *, /, %, (), and numeric literals (including decimals and negatives). No variables or functions.',
      usageExample:
        '{"type":"tool_call","name":"compute.eval","args":{"expression":"(8.5 + 7.2 + 6.9) / 3"}}',
      argsSchema: evalArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { expression } = evalArgs.parse(args);
        try {
          const result = safeEval(expression);
          if (!isFinite(result)) {
            return { success: false, error: 'Result is not a finite number' };
          }
          return { success: true, result, expression };
        } catch (err) {
          return { success: false, error: String(err instanceof Error ? err.message : err) };
        }
      },
    },
  ],
};
