import type { ToolCall } from '@clifford/sdk';
import { nanoid } from 'nanoid';

/**
 * LLM Stub for MVP
 * In production, this would call real LLM providers (OpenAI, Anthropic, etc.)
 */
export async function llmStub(inputText: string): Promise<LLMResponse> {
  const lower = inputText.toLowerCase();

  // Trigger tool calls based on input patterns
  if (lower.includes('ping')) {
    return {
      type: 'tool_calls',
      toolCalls: [
        {
          id: nanoid(),
          name: 'system.ping',
          args: {},
        },
      ],
    };
  }

  // Default: text response
  return {
    type: 'message',
    message: `I received your message: "${inputText}". This is a stub LLM response.`,
  };
}

export type LLMResponse =
  | {
      type: 'message';
      message: string;
    }
  | {
      type: 'tool_calls';
      toolCalls: ToolCall[];
    };
