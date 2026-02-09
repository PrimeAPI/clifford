import { createHash } from 'crypto';

export type CommitGuardState = {
  hasCommitted: boolean;
  committedHash: string | null;
  committedNormalized: string | null;
};

export type CommitDecision =
  | {
      allowCommit: true;
      normalized: string;
      hash: string;
    }
  | {
      allowCommit: false;
      reason: 'duplicate_hash' | 'duplicate_similar' | 'already_committed';
      normalized: string;
      hash: string;
      similarity?: number;
    };

export function normalizeMessageForCommit(message: string): string {
  return message
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:-]+|[\s.,!?;:-]+$/g, '')
    .trim();
}

export function hashNormalizedMessage(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

export function decideUserMessageCommit(
  state: CommitGuardState,
  message: string,
  similarityThreshold = 0.92
): CommitDecision {
  const normalized = normalizeMessageForCommit(message);
  const hash = hashNormalizedMessage(normalized);

  if (!state.hasCommitted || !state.committedHash || !state.committedNormalized) {
    return { allowCommit: true, normalized, hash };
  }

  if (state.committedHash === hash) {
    return { allowCommit: false, reason: 'duplicate_hash', normalized, hash };
  }

  const similarity = jaccardSimilarity(normalized, state.committedNormalized);
  if (similarity >= similarityThreshold) {
    return {
      allowCommit: false,
      reason: 'duplicate_similar',
      normalized,
      hash,
      similarity,
    };
  }

  return { allowCommit: false, reason: 'already_committed', normalized, hash };
}

function jaccardSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenizeForSimilarity(a));
  const bTokens = new Set(tokenizeForSimilarity(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  const union = aTokens.size + bTokens.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

function tokenizeForSimilarity(text: string): string[] {
  return text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}
