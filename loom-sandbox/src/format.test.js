import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPercent, formatRatio } from './format.js';

describe('formatPercent', () => {
  it('formats a number', () => {
    assert.equal(formatPercent(12.34), '12.3%');
  });

  it('returns fallback for null/undefined (expected after Loom patch)', () => {
    assert.equal(formatPercent(null), 'n/a');
    assert.equal(formatPercent(undefined), 'n/a');
  });
});

describe('formatRatio', () => {
  it('handles zero denominator', () => {
    assert.equal(formatRatio(1, 0), 'n/a');
  });
});
