/**
 * Embedding generation service using OpenAI's text-embedding-3-small model.
 * Produces 1536-dimensional vectors for semantic similarity search.
 */

export interface EmbeddingOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Generate an embedding vector for a single text input.
 */
export async function generateEmbedding(
  text: string,
  options: EmbeddingOptions
): Promise<EmbeddingResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embedding error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  if (!data.data?.[0]?.embedding) {
    throw new Error('OpenAI returned invalid embedding response');
  }

  return {
    embedding: data.data[0].embedding,
    tokensUsed: data.usage.total_tokens,
  };
}

/**
 * Generate embedding vectors for multiple text inputs in a batch.
 * More efficient than calling generateEmbedding multiple times.
 */
export async function generateEmbeddings(
  texts: string[],
  options: EmbeddingOptions
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) {
    return [];
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embedding error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  if (!data.data?.length) {
    throw new Error('OpenAI returned invalid embedding response');
  }

  // Sort by index to maintain order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  const tokensPerItem = Math.ceil(data.usage.total_tokens / texts.length);

  return sorted.map((item) => ({
    embedding: item.embedding,
    tokensUsed: tokensPerItem,
  }));
}

/**
 * Split text into chunks suitable for embedding.
 * Uses a simple character-based chunking strategy with overlap.
 */
export function chunkText(
  text: string,
  maxChunkSize = 512,
  overlap = 50
): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChunkSize, text.length);

    // Try to break at sentence or word boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);

      const breakPoint = Math.max(
        lastPeriod > start + maxChunkSize / 2 ? lastPeriod + 1 : start,
        lastNewline > start + maxChunkSize / 2 ? lastNewline + 1 : start,
        lastSpace > start + maxChunkSize / 2 ? lastSpace + 1 : start
      );

      if (breakPoint > start) {
        end = breakPoint;
      }
    }

    chunks.push(text.slice(start, end).trim());

    // Move start forward, accounting for overlap
    start = end - overlap;
    if (start < 0) start = 0;
    if (start >= text.length) break;

    // Skip if we'd create a very small final chunk
    if (text.length - start < overlap) break;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}
