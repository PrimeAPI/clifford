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

    return await callOpenAI(apiKey, fallbackModel, messages, options);
  }
}
