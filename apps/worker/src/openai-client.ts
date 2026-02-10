import { config } from './config.js';

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
  }
}

export async function callOpenAI(
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  options?: { temperature?: number }
) {
  const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401) {
      throw new OpenAIError(
        `OpenAI error 401: Unauthorized. Please verify your API key is valid and active. ${errorText}`
      );
    }
    throw new OpenAIError(`OpenAI error ${response.status}: ${errorText}`, response.status);
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new OpenAIError('OpenAI returned an empty response');
  }

  return content;
}

export async function callOpenAIWithFallback(
  apiKey: string,
  model: string,
  fallbackModel: string | null | undefined,
  messages: OpenAIMessage[],
  options?: { temperature?: number }
) {
  try {
    return await callOpenAI(apiKey, model, messages, options);
  } catch (err) {
    const error = err as OpenAIError;
    const status = error?.status;
    const shouldFallback = Boolean(
      fallbackModel &&
      fallbackModel.trim() &&
      model !== fallbackModel &&
      (status === undefined || status >= 429)
    );

    if (!shouldFallback) {
      throw err;
    }

    return await callOpenAI(apiKey, fallbackModel!, messages, options);
  }
}

// JSON Schema for OpenAI Structured Outputs
export interface JsonSchema {
  name: string;
  description?: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

export interface StructuredOutputOptions {
  temperature?: number;
}

/**
 * Call OpenAI with structured outputs (json_schema response format).
 * Returns parsed JSON that conforms to the provided schema.
 */
export async function callOpenAIStructured<T>(
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  jsonSchema: JsonSchema,
  options?: StructuredOutputOptions
): Promise<T> {
  const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: jsonSchema.name,
          description: jsonSchema.description,
          strict: jsonSchema.strict ?? true,
          schema: jsonSchema.schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401) {
      throw new OpenAIError(
        `OpenAI error 401: Unauthorized. Please verify your API key is valid and active. ${errorText}`
      );
    }
    throw new OpenAIError(`OpenAI error ${response.status}: ${errorText}`, response.status);
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new OpenAIError('OpenAI returned an empty response');
  }

  return JSON.parse(content) as T;
}

/**
 * Call OpenAI with structured outputs and fallback to a secondary model.
 */
export async function callOpenAIStructuredWithFallback<T>(
  apiKey: string,
  model: string,
  fallbackModel: string | null | undefined,
  messages: OpenAIMessage[],
  jsonSchema: JsonSchema,
  options?: StructuredOutputOptions
): Promise<T> {
  try {
    return await callOpenAIStructured<T>(apiKey, model, messages, jsonSchema, options);
  } catch (err) {
    const error = err as OpenAIError;
    const status = error?.status;
    const shouldFallback = Boolean(
      fallbackModel &&
      fallbackModel.trim() &&
      model !== fallbackModel &&
      (status === undefined || status >= 429)
    );

    if (!shouldFallback) {
      throw err;
    }

    return await callOpenAIStructured<T>(apiKey, fallbackModel!, messages, jsonSchema, options);
  }
}

// Models that support structured outputs (json_schema response format)
const STRUCTURED_OUTPUT_MODELS = new Set([
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-11-20',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'o1',
  'o1-2024-12-17',
  'o1-mini',
  'o3-mini',
  'o3-mini-2025-01-31',
]);

/**
 * Check if a model supports structured outputs.
 */
export function supportsStructuredOutputs(model: string): boolean {
  // Check exact match first
  if (STRUCTURED_OUTPUT_MODELS.has(model)) {
    return true;
  }
  // Check if it starts with any known prefix
  for (const known of STRUCTURED_OUTPUT_MODELS) {
    if (model.startsWith(known)) {
      return true;
    }
  }
  return false;
}
