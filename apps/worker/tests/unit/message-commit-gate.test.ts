import { describe, expect, it } from 'vitest';
import {
  decideUserMessageCommit,
  hashNormalizedMessage,
  normalizeMessageForCommit,
} from '../../src/message-commit-gate.js';

describe('normalizeMessageForCommit', () => {
  it('normalizes whitespace and casing', () => {
    expect(normalizeMessageForCommit('  Hello   WORLD \n')).toBe('hello world');
  });

  it('trims punctuation around edges', () => {
    expect(normalizeMessageForCommit('...Hello world!!!')).toBe('hello world');
  });
});

describe('hashNormalizedMessage', () => {
  it('is stable for identical normalized text', () => {
    const a = hashNormalizedMessage(normalizeMessageForCommit('Hello world'));
    const b = hashNormalizedMessage(normalizeMessageForCommit('  hello   world  '));
    expect(a).toBe(b);
  });
});

describe('decideUserMessageCommit', () => {
  const committedState = {
    hasCommitted: true,
    committedHash: hashNormalizedMessage(normalizeMessageForCommit('final answer here')),
    committedNormalized: normalizeMessageForCommit('final answer here'),
  };

  it('allows commit when no message has been committed yet', () => {
    const decision = decideUserMessageCommit(
      { hasCommitted: false, committedHash: null, committedNormalized: null },
      'Final answer here'
    );
    expect(decision.allowCommit).toBe(true);
  });

  it('blocks exact duplicates by hash', () => {
    const decision = decideUserMessageCommit(committedState, '  Final answer here ');
    expect(decision.allowCommit).toBe(false);
    if (!decision.allowCommit) {
      expect(decision.reason).toBe('duplicate_hash');
    }
  });

  it('blocks near duplicates by similarity', () => {
    const decision = decideUserMessageCommit(
      committedState,
      'This is the final answer here',
      0.5
    );
    expect(decision.allowCommit).toBe(false);
    if (!decision.allowCommit) {
      expect(decision.reason).toBe('duplicate_similar');
    }
  });

  it('blocks non-duplicate second commits due to single-commit rule', () => {
    const decision = decideUserMessageCommit(committedState, 'A different answer');
    expect(decision.allowCommit).toBe(false);
    if (!decision.allowCommit) {
      expect(decision.reason).toBe('already_committed');
    }
  });
});
