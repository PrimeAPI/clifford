import { parseToolCommandName } from '@clifford/sdk';
import type { z } from 'zod';

/**
 * Known command type literals from the command schema.
 */
const KNOWN_TYPES = new Set([
  'tool_call',
  'send_message',
  'set_output',
  'finish',
  'decision',
  'note',
  'set_run_limits',
  'spawn_subagent',
  'spawn_subagents',
  'sleep',
  'recover',
]);

/**
 * Keys that are part of the command schema (not tool args) for tool_call.
 */
const TOOL_CALL_RESERVED_KEYS = new Set(['type', 'name', 'args']);

/**
 * Common type aliases that models sometimes emit.
 */
const TYPE_ALIASES: Record<string, string> = {
  message: 'send_message',
  msg: 'send_message',
  send: 'send_message',
  tool: 'tool_call',
  call: 'tool_call',
  output: 'set_output',
  done: 'finish',
  end: 'finish',
  complete: 'finish',
  spawn: 'spawn_subagent',
  wait: 'sleep',
};

/**
 * Canonicalize a raw parsed JSON object into the expected command schema shape.
 * This runs BEFORE Zod validation to handle common model output variants.
 *
 * Returns a new object (does not mutate the input).
 */
export function canonicalize(raw: Record<string, unknown>): Record<string, unknown> {
  const obj = { ...raw };

  // 1. Shorthand tool call: {type: "web.search", args: {query: "x"}}
  //    → {type: "tool_call", name: "web.search", args: {query: "x"}}
  if (typeof obj.type === 'string' && !KNOWN_TYPES.has(obj.type)) {
    const parsed = parseToolCommandName(obj.type);
    if (parsed) {
      const { type: originalType, ...rest } = obj;
      return {
        type: 'tool_call',
        name: originalType,
        args: (rest.args as Record<string, unknown>) ?? rest,
      };
    }
  }

  // 2. Name-based tool call: {name: "web.search", args: {...}}
  //    → {type: "tool_call", name: "web.search", args: {...}}
  if (!obj.type && typeof obj.name === 'string') {
    const parsed = parseToolCommandName(obj.name);
    if (parsed) {
      return {
        type: 'tool_call',
        name: obj.name,
        args: (obj.args as Record<string, unknown>) ?? {},
      };
    }
  }

  // 3. Top-level arg flattening for tool_call:
  //    {type: "tool_call", name: "web.search", query: "x"}
  //    → {type: "tool_call", name: "web.search", args: {query: "x"}}
  if (obj.type === 'tool_call' && typeof obj.name === 'string' && !obj.args) {
    const extraKeys: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!TOOL_CALL_RESERVED_KEYS.has(key)) {
        extraKeys[key] = value;
      }
    }
    if (Object.keys(extraKeys).length > 0) {
      return {
        type: 'tool_call',
        name: obj.name,
        args: extraKeys,
      };
    }
  }

  // 4. Message alias: {type: "message", content: "..."} → {type: "send_message", message: "..."}
  if (typeof obj.type === 'string' && TYPE_ALIASES[obj.type]) {
    obj.type = TYPE_ALIASES[obj.type];
  }

  // 5. content → message for send_message
  if (obj.type === 'send_message' && !obj.message && typeof obj.content === 'string') {
    obj.message = obj.content;
    delete obj.content;
  }

  // 5b. file_ids/file_id aliases for send_message attachments
  if (obj.type === 'send_message') {
    if (!obj.fileIds && Array.isArray(obj.file_ids)) {
      obj.fileIds = obj.file_ids;
      delete obj.file_ids;
    }
    if (!obj.fileIds && typeof obj.file_id === 'string') {
      obj.fileIds = [obj.file_id];
      delete obj.file_id;
    }
  }

  // 6. {output: "...", done: true} without type → finish
  if (!obj.type && typeof obj.output === 'string' && (obj.done === true || obj.finished === true)) {
    return {
      type: 'finish',
      output: obj.output,
    };
  }

  return obj;
}

export interface RepairResult {
  repaired: Record<string, unknown>;
  applied: string[];
}

/**
 * Attempt to repair a raw object that failed Zod validation.
 * Only called when canonicalize + safeParse has already failed.
 *
 * Returns the repaired object and a list of applied repairs,
 * or null if no repairs could be applied.
 */
export function repair(
  raw: Record<string, unknown>,
  errors: z.ZodError
): RepairResult | null {
  const obj = { ...raw };
  const applied: string[] = [];

  for (const issue of errors.issues) {
    const path = issue.path.join('.');

    // Repair: content → message for send_message
    if (
      obj.type === 'send_message' &&
      path === 'message' &&
      typeof obj.content === 'string'
    ) {
      obj.message = obj.content;
      delete obj.content;
      applied.push('content→message');
      continue;
    }

    if (obj.type === 'send_message' && path === 'fileIds' && Array.isArray((obj as any).file_ids)) {
      (obj as any).fileIds = (obj as any).file_ids;
      delete (obj as any).file_ids;
      applied.push('file_ids→fileIds');
      continue;
    }

    // Repair: args as JSON string → parse to object
    if (path === 'args' && typeof obj.args === 'string') {
      try {
        const parsed = JSON.parse(obj.args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj.args = parsed;
          applied.push('args:string→object');
          continue;
        }
      } catch {
        // Cannot parse, skip this repair
      }
    }

    // Repair: text → content for note
    if (
      obj.type === 'note' &&
      path === 'content' &&
      typeof obj.text === 'string'
    ) {
      obj.content = obj.text;
      delete obj.text;
      applied.push('text→content');
      continue;
    }

    // Repair: number/boolean → string coercion for string fields
    if (issue.code === 'invalid_type' && issue.expected === 'string') {
      const target = path.split('.').reduce<unknown>((cur, key) => {
        if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key];
        return undefined;
      }, obj);
      if (typeof target === 'number' || typeof target === 'boolean') {
        setNestedValue(obj, path.split('.'), String(target));
        applied.push(`${path}:coerce→string`);
        continue;
      }
    }

    // Repair: maxIterations as string → number for set_run_limits
    if (
      obj.type === 'set_run_limits' &&
      path === 'maxIterations' &&
      typeof obj.maxIterations === 'string'
    ) {
      const num = parseInt(obj.maxIterations, 10);
      if (!isNaN(num) && num > 0) {
        obj.maxIterations = num;
        applied.push('maxIterations:string→number');
        continue;
      }
    }
  }

  if (applied.length === 0) {
    return null;
  }

  return { repaired: obj, applied };
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1]!;
  current[lastKey] = value;
}
