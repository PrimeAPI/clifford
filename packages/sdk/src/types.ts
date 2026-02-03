import { z } from 'zod';

// Tool Definition
export interface ToolDef {
  name: string;
  description: string;
  argsSchema: z.ZodSchema;
  handler: ToolHandler;
}

export type ToolHandler = (ctx: ToolContext, args: unknown) => Promise<unknown>;

export interface ToolContext {
  tenantId: string;
  agentId: string;
  runId: string;
  db: unknown; // Typed properly in db package
  logger: Logger;
}

export interface Logger {
  info: (msg: string, meta?: object) => void;
  warn: (msg: string, meta?: object) => void;
  error: (msg: string, meta?: object) => void;
  debug: (msg: string, meta?: object) => void;
}

// Tool Call & Result
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

// Plugin Interface
export interface Plugin {
  id: string;
  version: string;
  tools: ToolDef[];
}

// Policy
export type PolicyDecision = 'allow' | 'confirm' | 'deny';

export interface PolicyContext {
  tenantId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  policyProfile: string;
}

// Run Types
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepType = 'message' | 'tool_call' | 'tool_result';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  inputText: string;
  status: RunStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunStep {
  id: string;
  runId: string;
  seq: number;
  type: StepType;
  toolName?: string;
  argsJson?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
  status: StepStatus;
  idempotencyKey: string;
  createdAt: Date;
}
