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
      throw new Error(
        `OpenAI error 401: Unauthorized. Please verify your API key is valid and active. ${errorText}`
      );
    }
    throw new Error(`OpenAI error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error('OpenAI returned an empty response');
  }

  return content;
}
