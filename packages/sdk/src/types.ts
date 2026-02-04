import { z } from 'zod';

// Tool Definition
export type CommandClassification = 'READ' | 'WRITE' | 'DESTRUCT' | 'SENSITIVE';

export interface ToolCommandDef {
  name: string;
  shortDescription: string;
  longDescription: string;
  usageExample: string;
  argsSchema: z.ZodSchema;
  classification: CommandClassification;
  handler: ToolCommandHandler;
}

export interface ToolDef {
  name: string;
  shortDescription: string;
  longDescription: string;
  pinned?: boolean;
  important?: boolean;
  completeRequirement?: string;
  commands: ToolCommandDef[];
}

export type ToolCommandHandler = (ctx: ToolContext, args: unknown) => Promise<unknown>;

export interface ToolContext {
  tenantId: string;
  agentId: string;
  runId: string;
  db: unknown; // Typed properly in db package
  logger: Logger;
  toolResolver?: ToolResolver;
  userId?: string;
  channelId?: string;
}

type LogFn = {
  (msg: string, meta?: object): void;
  (obj: object, msg?: string): void;
};

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
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

export interface ToolResolver {
  listTools: () => ToolDef[];
  getTool: (name: string) => ToolDef | undefined;
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
  commandName: string;
  args: Record<string, unknown>;
  policyProfile: string;
}

// Run Types
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message'
  | 'output_update'
  | 'finish';
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

export function parseToolCommandName(
  fullName: string
): { toolName: string; commandName: string } | null {
  const splitIndex = fullName.indexOf('.');
  if (splitIndex <= 0 || splitIndex === fullName.length - 1) {
    return null;
  }

  return {
    toolName: fullName.slice(0, splitIndex),
    commandName: fullName.slice(splitIndex + 1),
  };
}

export function formatToolCommandName(toolName: string, commandName: string): string {
  return `${toolName}.${commandName}`;
}

export function getToolCommandNames(tool: ToolDef): string[] {
  return tool.commands.map((command) => command.name);
}

export function describeToolSummary(tool: ToolDef): string {
  const commandLines = tool.commands.map(
    (command) => `- ${command.name}: ${command.shortDescription}`
  );

  return [`${tool.name}: ${tool.shortDescription}`, 'Commands:', ...commandLines].join('\n');
}

export function describeToolBrief(tool: ToolDef): string {
  return `${tool.name}: ${tool.shortDescription}`;
}

export function describeToolDetails(tool: ToolDef): string {
  const commandBlocks = tool.commands.map((command) =>
    [
      `Command: ${command.name}`,
      `Summary: ${command.shortDescription}`,
      `Details: ${command.longDescription}`,
      `Usage: ${command.usageExample}`,
      `Classification: ${command.classification}`,
    ].join('\n')
  );

  return [
    `Tool: ${tool.name}`,
    `Summary: ${tool.shortDescription}`,
    `Details: ${tool.longDescription}`,
    tool.completeRequirement ? `Complete Requirement: ${tool.completeRequirement}` : null,
    'Commands:',
    ...commandBlocks,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
